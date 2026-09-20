/**
 * 汇报机械校验：在模型自述之外做机器能做的事——
 *
 * 1. 账本算术：v48 技能要求逐卡行之后附「核对账：账本X = 已发A + 跳过B + 失败C」。
 *    X ≠ A+B+C，或逐卡行里「已发送/已发表」的行数 ≠ A，都是数字编造/对不上的
 *    直接证据——不依赖任何设备侧信号，是最强的一道校验。
 * 2. 回执比对：手机端 COMPLETE/ABORT 尾部带「[回执] 各应用生效点击: com.tencent.wework=N」
 *    （TabbyApp ActionReceipt）。声称已发送/已发表张数 > 回执点击数（回执含导航
 *    点击、是上界）即不可信——拦「零生效点击却声称已发」这类极端虚报。
 *    声称数的提取：优先取核对账的 A；否则从多种真实措辞里取**最大值**（不求和——
 *    汇报常把同一个数复述多次，求和会把合法汇报判成虚报）。
 * 3. v1 结构化收据：按设备、实例、账号、企业、渠道、日期、完整时间和摘要去重，
 *    并严格检查发送、观察、最终扫描及组合覆盖。旧文本没有完整身份，不猜测跨轮去重。
 *
 * 4. 手机端设备校验行「[设备校验] …」（TabbyApp CompletionGate / IncidentTracker）：
 *    完成门控标注的「进展账本 i/N … 汇报声称 …」是模型被拒一次后仍坚持完成、汇报与账本对不上
 *    ——正面反证，转成告警；「结束时仍有未解决的问题」只说明无法核验，不改判（见 [judgeReport]）。
 *
 * 告警以「[桌面校验]」行追加进结果消息，且在 waiter resolve 之前完成，
 * 所以 RPC 同步返回与结果缓存拿到的是同一份带告警的消息。
 * 已持久化的结果会在协调器启动时重新灌入 sent 去重键，因此重启不会放过重复发送声称。
 */

import {
  WecomAuditReceiptV1Schema,
  type WecomAuditChannel,
  type WecomAuditReceiptV1,
} from "./protocol.js";

const RECEIPT_WECOM = /\[回执\][^\n]*?com\.tencent\.wework=(\d+)/;
/** 核对账：账本X = 已发A + 跳过B(...) + 失败C */
const LEDGER_SOURCE = String.raw`核对账[^\n]*?账本\s*(\d+)[^\n]*?已发\s*(\d+)[^\n]*?跳过\s*(\d+)[^\n]*?失败\s*(\d+)`;
const WECOM_AUDIT_MARKER = "[WECOM_AUDIT_V1]";
const WECOM_AUTOMATION_FAILURE_GUIDANCE =
  "[桌面校验] WECOM_AUDIT 是手机端自动执行完整性校验，不是人工确认或发送授权；" +
  "不会弹确认卡，也无需查找桌面授权开关或审计面板";
const WECOM_AUTOMATION_CONTEXT = /WECOM_AUDIT_(?:CHECKPOINT_INVALID|SEND_CHECKPOINT_REQUIRED)|\[WECOM_AUDIT_V1\]/;
/** 整行「卡片N | … | 分类=…」；渠道从行内的 已发送/已发表 判断。 */
const CARD_LINE_SINGLE = /^[^\n]*卡片\d+\s*[|｜][^\n]*$/;
const CARD_DONE = /(已发送|已发表)/;
const MAX_SEEN_RECEIPT_DAYS = 3;
/** 手机端追加的设备校验行（整行）。 */
const DEVICE_CHECK_LINE = /^\[设备校验\][^\n]*$/gm;
/** CompletionGate 注记：进展账本 i/N（可带系统收集条数）——汇报与账本矛盾。 */
const DEVICE_LEDGER_CONTRADICTION = /进展账本\s*\d+\s*\/\s*\d+|系统收集\s*\d+\s*条/;
/** IncidentTracker 注记：结束时仍有未解决的执行问题——无法核验，不是反证。 */
const DEVICE_UNRESOLVED = /结束时仍有未解决的问题/;
const DEVICE_GATE_WARNING_PREFIX = "[桌面校验] 手机端完成门控判定汇报与进展账本矛盾";
const MAX_SEEN_SENT_CARDS_PER_DAY = 100_000;
/** 车队实测过的声称措辞（全部只做候选，最终取最大值）。 */
const CLAIM_PATTERNS = [
  /已?发送\s*(\d+)\s*张/g,
  /(\d+)\s*张已发送/g,
  /已?发表\s*(\d+)\s*张/g,
  /(\d+)\s*张已发表/g,
  /完成\s*(\d+)\s*张/g,
  /共\s*(\d+)\s*张已发/g,
  /成功数[：:]?\s*(\d+)/g,
];

export function wecomLocalDayKey(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export interface WecomAuditRequirement {
  date: string;
  requiredChannels: WecomAuditChannel[];
  requiredInstanceKinds?: Array<"main" | "clone">;
  requiredInstances?: string[];
}

const SELF_PUBLISH_MARKERS = /(?:发布|发表|发送)以下|以下(?:朋友圈|内容|文案)|文案[:：]|物料|配图/;
const NEGATED_CLAUSE = /(?:不要|禁止|不得|无需|别|不)(?:执行|点击|点|按|操作|发送|发表)/;
const SEND_WORDING = /(?:发送|发表).{0,12}(?:卡片|卡|群发|朋友圈)|(?:群发|朋友圈|卡片).{0,12}(?:发送|发表)/;

/**
 * 「发送/发表」动词与「卡/群发/朋友圈」名词相邻，且不在否定从句里、也不是自发朋友圈。
 * 输入是去掉条件性禁令之后、但仍保留其余否定词的文本，这样才能按从句识别否定。
 */
function sendWordingIsAssigned(text: string): boolean {
  if (SELF_PUBLISH_MARKERS.test(text)) return false;
  const positive = text
    .split(/[，。；;：:]/)
    .filter((clause) => !NEGATED_CLAUSE.test(clause))
    .join("，");
  return SEND_WORDING.test(positive);
}

export function classifyWecomAuditRequirement(
  task: string,
  now = new Date(),
): WecomAuditRequirement | null {
  const normalized = task.replace(/\s+/g, "");
  const withoutConditionalGuards = normalized.replace(
    /(?:非今天|遇到验证)[^，。；;]{0,12}(?:不要|禁止|不)(?:发送|发表)/g,
    "",
  ).replace(
    /(?:不要|禁止|不)发送(?:昨天(?:和|及)?更早|昨天及以前|今天以前)(?:的)?卡片/g,
    "",
  );
  if (/(?:不要|禁止|不)(?:发送|发表)/.test(withoutConditionalGuards)) return null;
  const affirmative = normalized.replace(/(?:不要|禁止|不)(?:发送|发表|执行|处理|完成)/g, "");
  const explicitlyWecom = /企微|企业微信/.test(affirmative);
  if (/微信朋友圈/.test(affirmative) && !explicitlyWecom && !/1v1/.test(affirmative)) return null;

  const assignedExecution = /(?:执行|处理|完成|补发).{0,24}(?:1v1|群发助手|群发任务|朋友圈任务)/.test(affirmative)
    || /(?:1v1|群发助手|群发任务|朋友圈任务).{0,24}(?:执行|处理|完成|补发)/.test(affirmative)
    || /检查漏发并补发.{0,24}(?:1v1|群发助手|群发任务|朋友圈任务)/.test(affirmative)
    || (explicitlyWecom && /待发表/.test(affirmative) && /发表/.test(affirmative))
    || (explicitlyWecom && /(?:执行|处理|完成).{0,24}(?:指派|待办|任务)/.test(affirmative))
    // 2026-09-18: 「企微群发发送（只发两张卡）」「企微朋友圈检查…全部发表」做的是同一件事，却因为
    // 措辞不含「执行/待办/群发助手」而完全不触发审计，当天 7 次无收据的成功全走的这条缝。
    // 只要点明是企微，且「发送/发表」动词与「卡/群发/朋友圈」名词相邻，就按指派执行对待——
    // 但只看肯定从句：「发送操作不要执行」「禁止点击「发送」按钮」这类从句整条丢弃，
    // 携带文案/物料的自发朋友圈（「发布以下朋友圈：…」）也不算指派。
    || (explicitlyWecom && sendWordingIsAssigned(withoutConditionalGuards));
  if (!assignedExecution) return null;

  const requiredChannels: WecomAuditChannel[] = [];
  if (/1v1|群发|待发卡片/.test(affirmative)) requiredChannels.push("mass_send");
  if (/朋友圈/.test(affirmative)) requiredChannels.push("moments");
  if (requiredChannels.length === 0 && explicitlyWecom) {
    requiredChannels.push("mass_send", "moments");
  }
  if (requiredChannels.length === 0) return null;
  const requiredInstanceKinds: Array<"main" | "clone"> = [];
  if (/主应用|主实例|主企微/.test(affirmative)) requiredInstanceKinds.push("main");
  // Mirrors WeComExecutionLedger.requiresCloneInstanceFor on the phone. Every WeCom
  // task names 分身, and most of those mentions do not designate a target: 「分身角标」
  // describes what the icon looks like, and 「分身是 Erica羊」warns which account to
  // stay out of. Counting those rejected finished main-instance runs with "收据缺少
  // clone 实例"; counting none of them would miss 「执行主应用和分身…」. Dropping the
  // descriptive forms first leaves exactly the mentions that name a target.
  const targeting = affirmative
    .replace(/(?:不带|无|没有)分身角标/g, "")
    .replace(/分身(?:是|为)[^，。；、]{0,16}/g, "");
  if (/clone\d+/i.test(affirmative) || /分身/.test(targeting)) {
    requiredInstanceKinds.push("clone");
  }
  const requiredInstances = [...new Set(
    [...affirmative.matchAll(/clone\d+/gi)].map((match) => match[0].toLowerCase()),
  )];
  return {
    date: wecomLocalDayKey(now),
    requiredChannels,
    requiredInstanceKinds,
    requiredInstances,
  };
}

function extractWecomReceipt(message: string | undefined):
  | { receipt: WecomAuditReceiptV1 }
  | { error: string } {
  if (!message) return { error: "缺少 [WECOM_AUDIT_V1] 收据" };
  const occurrences = message.split(WECOM_AUDIT_MARKER).length - 1;
  if (occurrences !== 1) {
    return { error: occurrences === 0 ? "缺少 [WECOM_AUDIT_V1] 收据" : "存在重复 [WECOM_AUDIT_V1] 收据" };
  }
  const lastLine = message.trimEnd().split("\n").at(-1)?.trim() ?? "";
  if (!lastLine.startsWith(WECOM_AUDIT_MARKER)) {
    return { error: "[WECOM_AUDIT_V1] 必须是结果末尾的独立收据行" };
  }
  try {
    const raw: unknown = JSON.parse(lastLine.slice(WECOM_AUDIT_MARKER.length));
    const parsed = WecomAuditReceiptV1Schema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return { error: `收据字段无效 ${issue.path.join(".")}: ${issue.message}` };
    }
    return { receipt: parsed.data };
  } catch (error) {
    return { error: `收据 JSON 无效: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function scopeKey(scope: WecomAuditReceiptV1["scopes"][number]): string {
  return [scope.instance, scope.account, scope.company, scope.channel].join("\u0000");
}

function sentCardKeys(deviceId: string, receipt: WecomAuditReceiptV1): string[] {
  return receipt.scopes.flatMap((scope) => scope.cards.flatMap((card) => (
    card.status === "sent"
      ? [[deviceId, scopeKey(scope), receipt.date, card.time, card.summary].join("\u0000")]
      : []
  )));
}

/** Keep a runtime receipt intact and last when desktop validation adds warnings. */
export function appendReportAuditWarnings(message: string | undefined, warnings: string[]): string {
  const lines = (message ?? "").trimEnd().split("\n");
  const effectiveWarnings = [...warnings];
  const auditContext = [message ?? "", ...warnings].join("\n");
  if (WECOM_AUTOMATION_CONTEXT.test(auditContext)
    && !lines.includes(WECOM_AUTOMATION_FAILURE_GUIDANCE)
    && !effectiveWarnings.includes(WECOM_AUTOMATION_FAILURE_GUIDANCE)) {
    effectiveWarnings.unshift(WECOM_AUTOMATION_FAILURE_GUIDANCE);
  }
  const lastLine = lines.at(-1) ?? "";
  if (lastLine.trimStart().startsWith(WECOM_AUDIT_MARKER)) {
    lines.pop();
    return [...lines, ...effectiveWarnings, lastLine].filter(Boolean).join("\n");
  }
  return [...lines, ...effectiveWarnings].filter(Boolean).join("\n");
}

export type AuditVerdict = "consistent" | "unverifiable" | "contradicted";

export interface AuditJudgement {
  verdict: AuditVerdict;
  basis: string[];
}

/**
 * 三态判决（借鉴 Artemis checker 的结果规范化：没有证据的"失败"降级为无法核验）：
 * - contradicted：存在正面反证——任何桌面告警（账本算术、声称数 > 回执、收据问题、手机端账本矛盾注记）；
 * - unverifiable：声称了发送数量却既无回执也无核对账，或手机端标注结束时仍有未解决的执行问题；
 * - consistent：其余。
 * 只有 contradicted 才会被协调器改判失败；unverifiable 只记日志，避免告警疲劳。
 */
export function judgeReport(message: string | undefined, warnings: string[]): AuditJudgement {
  if (warnings.length > 0) {
    return { verdict: "contradicted", basis: warnings.map((w) => w.replace("[桌面校验] ", "")) };
  }
  const text = (message ?? "").replace(/\\n/g, "\n");
  const basis: string[] = [];
  for (const line of text.match(DEVICE_CHECK_LINE) ?? []) {
    if (DEVICE_UNRESOLVED.test(line)) basis.push(line.replace("[设备校验] ", ""));
  }
  const claimed = extractClaimedCount(text);
  if (claimed != null && !RECEIPT_WECOM.test(text) && !new RegExp(LEDGER_SOURCE).test(text)) {
    basis.push(`声称已发送/已发表 ${claimed} 张，但没有回执或核对账可比对`);
  }
  return basis.length > 0 ? { verdict: "unverifiable", basis } : { verdict: "consistent", basis };
}

/** 该告警只来自手机端完成门控（非企微收据/账本问题）：协调器据此给出不带企微语义的错误码。 */
export function isDeviceGateWarning(warning: string): boolean {
  return warning.startsWith(DEVICE_GATE_WARNING_PREFIX);
}

export function extractClaimedCount(message: string): number | null {
  const ledger = new RegExp(LEDGER_SOURCE).exec(message);
  if (ledger) return Number(ledger[2]);
  let max: number | null = null;
  for (const re of CLAIM_PATTERNS) {
    re.lastIndex = 0;
    for (const m of message.matchAll(re)) {
      const n = Number(m[1]);
      if (max == null || n > max) max = n;
    }
  }
  return max;
}

export class ReportAuditor {
  private seenSentCardsByDate = new Map<string, Set<string>>();

  /** @returns 要追加到结果消息的告警行（空数组 = 通过）。 */
  audit(_deviceId: string, message: string | undefined, _now = new Date()): string[] {
    if (!message) return [];
    if ("receipt" in extractWecomReceipt(message)) return [];
    // 旧版手机端可能把换行写成字面 "\\n"——逐卡行按真实换行匹配，先归一化。
    message = message.replace(/\\n/g, '\n');
    const warnings: string[] = [];

    // 1) 账本算术
    let sectionDoneLines = 0;
    for (const line of message.split("\n")) {
      if (CARD_LINE_SINGLE.test(line) && CARD_DONE.test(line)) sectionDoneLines += 1;
      const ledger = new RegExp(LEDGER_SOURCE).exec(line);
      if (!ledger) continue;
      const [total, sent, skipped, failed] = ledger.slice(1, 5).map(Number) as [
        number, number, number, number,
      ];
      if (total !== sent + skipped + failed) {
        warnings.push(
          `[桌面校验] 核对账不平：账本${total} ≠ 已发${sent} + 跳过${skipped} + 失败${failed}——数字不可信，请人工在手机上核对`,
        );
      }
      if (sectionDoneLines !== sent) {
        warnings.push(
          `[桌面校验] 本段逐卡行有${sectionDoneLines}张标为已完成，核对账却记已发${sent}——汇报自相矛盾，请人工核对`,
        );
      }
      sectionDoneLines = 0;
    }

    // 2) 回执比对
    const receipt = RECEIPT_WECOM.exec(message)?.[1];
    const claimed = extractClaimedCount(message);
    if (receipt != null && claimed != null) {
      const receiptCount = Number(receipt);
      if (claimed > receiptCount) {
        warnings.push(
          `[桌面校验] 声称已发送/已发表${claimed}张 > 回执生效点击${receiptCount}次`
          + `（回执含导航点击、是上界）——汇报数字不可信，请人工在手机上核对`,
        );
      }
    }

    // 3) 手机端完成门控注记：模型被拒一次后仍坚持完成，汇报与进展账本/收集条目对不上
    for (const line of message.match(DEVICE_CHECK_LINE) ?? []) {
      if (DEVICE_LEDGER_CONTRADICTION.test(line)) {
        warnings.push(
          `${DEVICE_GATE_WARNING_PREFIX}（${line.replace("[设备校验] ", "")}）——汇报不可信，请人工核对`,
        );
      }
    }

    return warnings;
  }

  auditWecomReceipt(
    deviceId: string,
    message: string | undefined,
    requirement: WecomAuditRequirement | undefined,
    now = new Date(),
  ): string[] {
    const warnings = requirement
      ? []
      : ["[桌面校验] 缺少派发核验记录，无法确认任务范围"];
    const extracted = extractWecomReceipt(message);
    if ("error" in extracted) return [...warnings, `[桌面校验] ${extracted.error}`];
    const { receipt } = extracted;
    const expectedDate = requirement?.date ?? wecomLocalDayKey(now);
    if ((requirement && requirement.date !== wecomLocalDayKey(now))
      || receipt.date !== expectedDate) {
      warnings.push("[桌面校验] 企微任务已跨日或收据日期与派发日期不一致");
    }
    if (requirement
      && (receipt.requiredChannels.length !== requirement.requiredChannels.length
      || requirement.requiredChannels.some((channel) => !receipt.requiredChannels.includes(channel)))) {
      warnings.push("[桌面校验] 收据 requiredChannels 与派发要求不一致");
    }
    const instances = new Set(receipt.expectedScopes.map((scope) => scope.instance));
    if (requirement?.requiredInstanceKinds?.includes("main") && !instances.has("main")) {
      warnings.push("[桌面校验] 任务明确要求主应用，但收据缺少 main 实例");
    }
    if (requirement?.requiredInstanceKinds?.includes("clone")
      && ![...instances].some((instance) => /^clone\d+$/.test(instance))) {
      warnings.push("[桌面校验] 任务明确要求分身，但收据缺少 clone 实例");
    }
    for (const instance of requirement?.requiredInstances ?? []) {
      if (!instances.has(instance)) {
        warnings.push(`[桌面校验] 任务明确要求实例 ${instance}，但收据未覆盖`);
      }
    }
    for (const scope of receipt.scopes) {
      if (!scope.inventoryComplete || !scope.finalScanComplete || scope.remaining !== 0) {
        warnings.push(`[桌面校验] 组合 ${scope.instance}/${scope.account}/${scope.company}/${scope.channel} 未完成最终核验`);
      }
      const unresolved = scope.cards.find((card) => (
        card.status === "pending" || card.status === "blocked" || card.status === "unknown"
      ));
      if (unresolved) {
        warnings.push(`[桌面校验] 卡片 ${unresolved.id} 仍为待处理或未核实状态 ${unresolved.status}`);
      }
    }

    const seenSentCards = this.seenSentCardsByDate.get(receipt.date) ?? new Set<string>();
    const keys = sentCardKeys(deviceId, receipt);
    const currentReceiptKeys = new Set<string>();
    let duplicateSentCount = 0;
    for (const key of keys) {
      if (seenSentCards.has(key) || currentReceiptKeys.has(key)) {
        duplicateSentCount += 1;
      }
      currentReceiptKeys.add(key);
    }
    if (duplicateSentCount > 0) {
      warnings.push(`[桌面校验] ${duplicateSentCount} 条相同身份、渠道、日期、完整时间和摘要的 sent 已在其他任务中记录，禁止重复声称成功`);
    }
    if (warnings.length === 0) {
      for (const key of currentReceiptKeys) seenSentCards.add(key);
      this.seenSentCardsByDate.set(receipt.date, seenSentCards);
      this.pruneSeenSentCards();
    }
    return warnings;
  }

  seedWecomReceipt(deviceId: string, message: string | undefined): void {
    const extracted = extractWecomReceipt(message);
    if ("error" in extracted) return;
    const seenSentCards = this.seenSentCardsByDate.get(extracted.receipt.date) ?? new Set<string>();
    for (const key of sentCardKeys(deviceId, extracted.receipt)) {
      seenSentCards.add(key);
    }
    this.seenSentCardsByDate.set(extracted.receipt.date, seenSentCards);
    this.pruneSeenSentCards();
  }

  private pruneSeenSentCards(): void {
    const dates = [...this.seenSentCardsByDate.keys()].sort().reverse();
    for (const date of dates.slice(MAX_SEEN_RECEIPT_DAYS)) {
      this.seenSentCardsByDate.delete(date);
    }
    for (const cards of this.seenSentCardsByDate.values()) {
      while (cards.size > MAX_SEEN_SENT_CARDS_PER_DAY) {
        const oldest = cards.values().next();
        if (oldest.done) break;
        cards.delete(oldest.value);
      }
    }
  }
}
