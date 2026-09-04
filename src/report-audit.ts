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
 * 3. 当日同卡去重：同一设备、同一渠道（发送/发表）、同一张卡（摘要前 10 字）在
 *    当天被两轮各自汇报为已完成，必有一轮虚报或重复执行（D2 的 Cara 卡案）。
 *    渠道计入键：同一份文案常同时下发 1v1 和朋友圈，只按摘要会误报。
 *
 * 告警以「[桌面校验]」行追加进结果消息，且在 waiter resolve 之前完成，
 * 所以 RPC 同步返回与结果缓存拿到的是同一份带告警的消息。
 * 当日记忆是进程内的（按本地日期滚动）：网关重启后清零，只丢跨重启的去重。
 */

const RECEIPT_WECOM = /\[回执\][^\n]*?com\.tencent\.wework=(\d+)/;
/** 核对账：账本X = 已发A + 跳过B(...) + 失败C */
const LEDGER =
  /核对账[^\n]*?账本\s*(\d+)[^\n]*?已发\s*(\d+)[^\n]*?跳过\s*(\d+)[^\n]*?失败\s*(\d+)/;
/** 整行「卡片N | … | 分类=…」；渠道从行内的 已发送/已发表 判断。 */
const CARD_LINE = /^[^\n]*卡片\d+\s*[|｜][^\n]*$/gm;
const CARD_SUMMARY = /摘要=\s*(.{1,10})/;
const CARD_DONE = /(已发送|已发表)/;
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

function localDayKey(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function extractClaimedCount(message: string): number | null {
  const ledger = LEDGER.exec(message);
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
  private dayKey = '';
  /** deviceId → 当日已汇报为已完成的「渠道:摘要前缀」集合。 */
  private seenCards = new Map<string, Set<string>>();

  /** @returns 要追加到结果消息的告警行（空数组 = 通过）。 */
  audit(deviceId: string, message: string | undefined, now = new Date()): string[] {
    if (!message) return [];
    this.rollDay(now);
    // 旧版手机端可能把换行写成字面 "\\n"——逐卡行按真实换行匹配，先归一化。
    message = message.replace(/\\n/g, '\n');
    const warnings: string[] = [];

    // 逐卡行：同时用于账本对账和去重
    const doneLines: string[] = [];
    for (const m of message.matchAll(CARD_LINE)) {
      if (CARD_DONE.test(m[0])) doneLines.push(m[0]);
    }

    // 1) 账本算术
    const ledger = LEDGER.exec(message);
    if (ledger) {
      const [total, sent, skipped, failed] = ledger.slice(1, 5).map(Number) as [
        number, number, number, number,
      ];
      if (total !== sent + skipped + failed) {
        warnings.push(
          `[桌面校验] 核对账不平：账本${total} ≠ 已发${sent} + 跳过${skipped} + 失败${failed}——数字不可信，请人工在手机上核对`,
        );
      }
      if (doneLines.length > 0 && doneLines.length !== sent) {
        warnings.push(
          `[桌面校验] 逐卡行有${doneLines.length}张标为已完成，核对账却记已发${sent}——汇报自相矛盾，请人工核对`,
        );
      }
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

    // 3) 当日同卡重复（渠道 + 摘要前缀）
    const seen = this.seenCards.get(deviceId) ?? new Set<string>();
    for (const line of doneLines) {
      const summary = CARD_SUMMARY.exec(line)?.[1];
      const channel = CARD_DONE.exec(line)?.[1];
      if (summary == null || channel == null) continue;
      const key = `${channel}:${summary}`;
      if (seen.has(key)) {
        warnings.push(
          `[桌面校验] 卡片「${summary}…」当日已被其他轮次汇报为${channel}——重复计入或虚报，请核对`,
        );
      } else {
        seen.add(key);
      }
    }
    if (seen.size > 0) this.seenCards.set(deviceId, seen);
    return warnings;
  }

  private rollDay(now: Date): void {
    const key = localDayKey(now);
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.seenCards.clear();
    }
  }
}
