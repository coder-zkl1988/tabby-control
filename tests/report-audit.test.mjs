import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ReportAuditor,
  appendReportAuditWarnings,
  classifyWecomAuditRequirement,
  extractClaimedCount,
} from '../dist/report-audit.js';

const NOW = new Date(2026, 8, 4, 14, 0, 0); // 本地 2026-09-04 14:00
const RECEIPT = (n) => `[回执] 各应用生效点击: com.tencent.wework=${n}`;
const receiptFixture = JSON.parse(readFileSync(
  new URL('./fixtures/wecom-audit-v1.json', import.meta.url),
  'utf8',
));
const intentFixture = JSON.parse(readFileSync(
  new URL('./fixtures/wecom-task-intents.json', import.meta.url),
  'utf8',
));
const auditLine = (receipt) => `[WECOM_AUDIT_V1]${JSON.stringify(receipt)}`;

test('send/publish wording adjacent to card/群发/朋友圈 nouns counts as assigned execution (2026-09-18 bypass)', () => {
  const now = new Date('2026-09-18T12:00:00+08:00');
  const bulk = classifyWecomAuditRequirement(
    '企微群发发送（katy羊 @新氧，只发两张卡）。第一步：彻底关闭企微应用，再重新打开；通过 AWAKE 弹窗进入【带分身角标的企微分身】，核对水印为「katy羊@新氧」',
    now,
  );
  assert.ok(bulk, 'bulk-send wording must require an audit receipt');
  assert.deepEqual(bulk.requiredChannels, ['mass_send']);

  const moments = classifyWecomAuditRequirement(
    '企微朋友圈检查（katy羊@新氧）：今日指派卡片按从早到新顺序全部发表',
    now,
  );
  assert.ok(moments, 'moments publish wording must require an audit receipt');
  assert.deepEqual(moments.requiredChannels, ['moments']);

  const readOnly = classifyWecomAuditRequirement(
    '只读导航，禁止点击任何「发送」「发表」按钮：通过 AWAKE 弹窗进入企微主应用，在消息列表里找到「群发助手」会话并点进去，停在群发助手页面',
    now,
  );
  assert.equal(readOnly, null, 'read-only navigation must not require a receipt');
});

test('desktop warnings preserve the exact final receipt for subsequent validation', () => {
  const receipt = auditLine(receiptFixture);
  const warning = '[桌面校验] 缺少派发核验记录，无法确认任务范围';
  const message = appendReportAuditWarnings(`完成\n${receipt}\n`, [warning]);
  assert.equal(message.split('\n').at(-1), receipt);
  assert.ok(message.includes(warning));
  const auditor = new ReportAuditor();
  assert.deepEqual(auditor.auditWecomReceipt('phone-warning', message, {
    date: receiptFixture.date,
    requiredChannels: receiptFixture.requiredChannels,
  }, new Date(2026, 8, 9, 20, 0, 0)), []);
  assert.equal(appendReportAuditWarnings('没有收据', [warning]), `没有收据\n${warning}`);
});

test('automatic WeCom protocol failures cannot be mistaken for human approval gates', () => {
  const emptyReceipt = auditLine({
    version: 1,
    date: '2026-09-09',
    requiredChannels: ['mass_send', 'moments'],
    expectedScopes: [],
    scopes: [],
  });
  const message = appendReportAuditWarnings(
    `WECOM_AUDIT_CHECKPOINT_INVALID: payload must be one JSON object\n${emptyReceipt}`,
    ['[桌面校验] 收据字段无效 expectedScopes'],
  );

  assert.match(message, /WECOM_AUDIT 是手机端自动执行完整性校验/);
  assert.match(message, /不是人工确认或发送授权/);
  assert.match(message, /不会弹确认卡/);
  assert.match(message, /无需查找桌面授权开关或审计面板/);
  assert.equal(message.split('\n').at(-1), emptyReceipt);
  assert.equal((message.match(/WECOM_AUDIT 是手机端自动执行完整性校验/g) ?? []).length, 1);
});

test('business-incomplete receipts explain automatic audit semantics without claiming a format failure', () => {
  const receipt = auditLine({
    version: 1,
    date: '2026-09-09',
    requiredChannels: ['mass_send'],
    expectedScopes: ['main|corp-a|mass_send'],
    scopes: [
      {
        appInstance: 'main',
        company: 'corp-a',
        channel: 'mass_send',
        expectedCards: 2,
        sentCards: 1,
        skippedCards: 0,
        failedCards: 1,
        status: 'failed',
      },
    ],
  });

  const message = appendReportAuditWarnings(
    `WECOM_AUDIT_INCOMPLETE: one business card failed\n${receipt}`,
    [],
  );

  assert.match(message, /不是人工确认或发送授权/);
  assert.equal(message.includes('修正检查点格式'), false);
  assert.equal(message.trimEnd().endsWith(receipt), true);
});

test('claimed-count extraction covers the phrasings the fleet actually produced', () => {
  // 每条都是 09-02/09-03 车队汇报原文形态；此前的正则对其中 6 条提取为 0。
  const cases = [
    ['1v1群发任务结果：\n- 发送2张（当天待发卡片）', 2],           // Gallagher D2-①
    ['汇总：2张已发送，1张跳过', 2],                                  // kaycee
    ['已发送2张：胶原文案（下午5:14）', 2],                           // katy
    ['1v1群发结果：完成1张当天指派群发', 1],                          // Edith 医疗
    ['1v1群发助手：今日共1张已发送', 1],                              // Erica 医疗
    ['朋友圈结果：发表1张（09月03日10:11）', 1],
    ['朋友圈成功数2（Beverly羊09/02 10:33）', 2],
    ['今日共2张卡片，9:06 已发送、10:11 已发送', null],               // 无数字声称：不做判断
  ];
  for (const [text, expected] of cases) {
    assert.equal(extractClaimedCount(text), expected, text);
  }
});

test('restated numbers are not summed — max wins, and the ledger line takes precedence', () => {
  assert.equal(extractClaimedCount('已发送 2 张；朋友圈已发表 1 张；汇总：2张已发送'), 2);
  assert.equal(
    extractClaimedCount('已发送 3 张\n核对账：账本3 = 已发2 + 跳过1(含已取消) + 失败0；处理后剩余1张'),
    2,
  );
});

test('ledger arithmetic that does not balance is flagged without needing a receipt', () => {
  const auditor = new ReportAuditor();
  const warnings = auditor.audit(
    '0356',
    '核对账：账本3 = 已发2 + 跳过0 + 失败0；处理后剩余1张',
    NOW,
  );
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((warning) => /核对账不平：账本3 ≠ 已发2 \+ 跳过0 \+ 失败0/.test(warning)));
  assert.ok(warnings.some((warning) => /逐卡行有0张.*已发2/.test(warning)));
});

test('per-card done lines must agree with the ledger sent count', () => {
  const auditor = new ReportAuditor();
  const msg = [
    '卡片1 | 上方时间标注=上午9:06 | 摘要=漾活光彩针活动 | 分类=今天已发送',
    '卡片2 | 上方时间标注=上午10:11 | 摘要=深圳锦鲤福利 | 分类=今天已发送',
    '核对账：账本2 = 已发1 + 跳过0 + 失败1；处理后剩余1张',
  ].join('\n');
  const warnings = auditor.audit('376e', msg, NOW);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /逐卡行有2张标为已完成，核对账却记已发1/);
});

test('separate legacy ledgers count only the card lines in their own preceding section', () => {
  const auditor = new ReportAuditor();
  const message = [
    '组合=main/account-a/company-a/mass_send',
    '卡片1 | 时间=09:00 | 摘要=第一张 | 分类=今天已发送',
    '核对账：账本1 = 已发1 + 跳过0 + 失败0',
    '组合=clone1/account-b/company-b/moments',
    '卡片1 | 时间=10:00 | 摘要=第二张 | 分类=今天已发表',
    '核对账：账本1 = 已发1 + 跳过0 + 失败0',
  ].join('\n');
  assert.deepEqual(auditor.audit('phone-1', message, NOW), []);
});

test('claims exceeding the receipt warn as untrusted; claims within it pass', () => {
  const auditor = new ReportAuditor();
  const bad = auditor.audit('22101317C', `发送2张（当天待发卡片）\n${RECEIPT(1)}`, NOW);
  assert.equal(bad.length, 1);
  assert.match(bad[0], /声称已发送\/已发表2张 > 回执生效点击1次/);
  assert.deepEqual(auditor.audit('22101317C', `已发送 2 张；已发表 1 张\n${RECEIPT(5)}`, NOW), []);
});

test('legacy card text without structured identity is never guessed for cross-run dedup', () => {
  const auditor = new ReportAuditor();
  const sent = '卡片1 | 上方时间标注=下午 3:38 | 摘要=Knock! 羊的械2卫生 | 分类=今天已发送';
  const published = '卡片1 | 日期时间=09月04日10:33 | 摘要=Knock! 羊的械2卫生 | 分类=今天已发表';
  assert.deepEqual(auditor.audit('0356', sent, NOW), []);
  // 同文案走朋友圈渠道不算重复（同一份文案常同时下发两个渠道）
  assert.deepEqual(auditor.audit('0356', published, NOW), []);
  assert.deepEqual(auditor.audit('0356', sent, NOW), []);
  assert.deepEqual(auditor.audit('376e', sent, NOW), []);
});

test('skipped cards never enter the dedup set', () => {
  const auditor = new ReportAuditor();
  const skipped = '卡片1 | 上方时间标注=昨天 | 摘要=Hannah羊通知 | 分类=跳过(早于今天)';
  assert.deepEqual(auditor.audit('0356', skipped, NOW), []);
  assert.deepEqual(auditor.audit('0356', skipped, NOW), []);
});

test('legacy card text remains free of inferred identity across local dates', () => {
  const auditor = new ReportAuditor();
  const msg = '卡片1 | 时间标注=下午 3:38 | 摘要=Knock! 羊的械 | 分类=今天已发送';
  // 本地 09-04 07:00 与 09:00 是同一天（UTC 里跨了 23:00→01:00 的日界）
  assert.deepEqual(auditor.audit('0356', msg, new Date(2026, 8, 4, 7, 0, 0)), []);
  assert.deepEqual(auditor.audit('0356', msg, new Date(2026, 8, 4, 9, 0, 0)), []);
  assert.deepEqual(auditor.audit('0356', msg, new Date(2026, 8, 5, 9, 0, 0)), []);
});

test('literal backslash-n newlines are normalized before per-card matching', () => {
  const auditor = new ReportAuditor();
  const msg = '已发送 1 张\\n卡片1 | 上方时间标注=下午 3:38 | 摘要=Knock! 羊的械 | 分类=今天已发送\\n核对账：账本1 = 已发1 + 跳过0 + 失败0';
  assert.deepEqual(auditor.audit('0356', msg, NOW), []);
  assert.deepEqual(auditor.audit('0356', msg, NOW), []);
});

test('shared intent fixture identifies assigned WeCom execution without catching read-only or self-publish tasks', () => {
  for (const row of intentFixture) {
    const requirement = classifyWecomAuditRequirement(row.task, new Date(2026, 8, 9, 9, 0, 0));
    assert.equal(requirement != null, row.channels.length > 0, row.task);
    assert.deepEqual(requirement?.requiredChannels ?? [], row.channels, row.task);
  }
});

test('an old-card send prohibition remains a guard on an otherwise assigned task', () => {
  const requirement = classifyWecomAuditRequirement(
    '执行今天1v1和朋友圈任务；禁止发送昨天和更早卡片',
    new Date(2026, 8, 9, 9, 0, 0),
  );
  assert.deepEqual(requirement?.requiredChannels, ['mass_send', 'moments']);
});

test('strict v1 receipt accepts the shared fixture and rejects incomplete or contradictory success evidence', () => {
  const requirement = {
    date: '2026-09-09',
    requiredChannels: ['mass_send', 'moments'],
  };
  const auditor = new ReportAuditor();
  assert.deepEqual(
    auditor.auditWecomReceipt('phone-1', auditLine(receiptFixture), requirement, new Date(2026, 8, 9, 20, 0, 0)),
    [],
  );

  const missingScope = structuredClone(receiptFixture);
  missingScope.scopes.pop();
  assert.match(
    auditor.auditWecomReceipt('phone-2', auditLine(missingScope), requirement, new Date(2026, 8, 9, 20, 0, 0))[0],
    /scope|组合|渠道/i,
  );

  const pending = structuredClone(receiptFixture);
  pending.scopes[0].cards[0].status = 'pending';
  delete pending.scopes[0].cards[0].sentStep;
  delete pending.scopes[0].cards[0].verifiedStep;
  assert.match(
    auditor.auditWecomReceipt('phone-3', auditLine(pending), requirement, new Date(2026, 8, 9, 20, 0, 0))[0],
    /pending|待处理/i,
  );

  const badSteps = structuredClone(receiptFixture);
  badSteps.scopes[0].cards[0].verifiedStep = badSteps.scopes[0].cards[0].sentStep;
  assert.match(
    auditor.auditWecomReceipt('phone-4', auditLine(badSteps), requirement, new Date(2026, 8, 9, 20, 0, 0))[0],
    /verifiedStep|步骤/i,
  );

  assert.match(
    auditor.auditWecomReceipt('phone-5', auditLine(receiptFixture), requirement, new Date(2026, 8, 10, 0, 1, 0))[0],
    /跨日|日期/i,
  );

  for (const status of ['pending', 'blocked', 'unknown']) {
    const unresolved = structuredClone(receiptFixture);
    unresolved.scopes[0].cards[0].status = status;
    delete unresolved.scopes[0].cards[0].sentStep;
    delete unresolved.scopes[0].cards[0].verifiedStep;
    assert.match(
      auditor.auditWecomReceipt(`phone-${status}`, auditLine(unresolved), requirement, new Date(2026, 8, 9, 20, 0, 0))[0],
      /待处理|未核实|blocked|pending|unknown/i,
    );
  }

  for (const evidence of [
    '看不清是否已发送',
    '仍未发送',
    '没有已发送标记',
    '未找到发送记录',
    '未看到已发送',
  ]) {
    const ambiguousSent = structuredClone(receiptFixture);
    ambiguousSent.scopes[0].cards[0].evidence = evidence;
    assert.match(
      auditor.auditWecomReceipt(`bad-evidence-${evidence}`, auditLine(ambiguousSent), requirement, new Date(2026, 8, 9, 20, 0, 0))[0],
      /evidence|状态原文|证据/i,
    );
  }

  const ambiguousAlreadySent = structuredClone(receiptFixture);
  ambiguousAlreadySent.scopes[0].cards[2].evidence = '状态看不清';
  assert.match(
    auditor.auditWecomReceipt('bad-already-sent', auditLine(ambiguousAlreadySent), requirement, new Date(2026, 8, 9, 20, 0, 0))[0],
    /evidence|状态原文|证据/i,
  );

  const ambiguousCancelled = structuredClone(receiptFixture);
  ambiguousCancelled.scopes[0].cards[2].status = 'cancelled';
  ambiguousCancelled.scopes[0].cards[2].evidence = '无法确认是否取消';
  assert.match(
    auditor.auditWecomReceipt('bad-cancelled', auditLine(ambiguousCancelled), requirement, new Date(2026, 8, 9, 20, 0, 0))[0],
    /evidence|状态原文|证据/i,
  );
});

test('strict receipt rejects stale final scans, empty coverage, and duplicate channels or scopes', () => {
  const requirement = { date: '2026-09-09', requiredChannels: ['mass_send', 'moments'] };
  const auditor = new ReportAuditor();

  const staleFinalScan = structuredClone(receiptFixture);
  staleFinalScan.scopes[1].cards.push({
    id: 'late-observation',
    date: '2026-09-09',
    time: '19:10',
    summary: '最终扫描后才观察到的已发送卡片',
    status: 'already_sent',
    evidence: '已发表',
    observedStep: 66,
  });
  assert.match(
    auditor.auditWecomReceipt('stale-final', auditLine(staleFinalScan), requirement, new Date(2026, 8, 9, 20, 0, 0))[0],
    /finalScanStep|最终扫描|步骤/i,
  );

  for (const field of ['requiredChannels', 'expectedScopes', 'scopes']) {
    const empty = structuredClone(receiptFixture);
    empty[field] = [];
    assert.match(
      auditor.auditWecomReceipt(`empty-${field}`, auditLine(empty), requirement, new Date(2026, 8, 9, 20, 0, 0))[0],
      /无效|empty|至少|array|scope|channel/i,
    );
  }

  const duplicateChannel = structuredClone(receiptFixture);
  duplicateChannel.requiredChannels.push('moments');
  assert.match(
    auditor.auditWecomReceipt('duplicate-channel', auditLine(duplicateChannel), requirement, new Date(2026, 8, 9, 20, 0, 0))[0],
    /duplicate channel|重复.*渠道/i,
  );

  const duplicateScope = structuredClone(receiptFixture);
  duplicateScope.expectedScopes.push(structuredClone(duplicateScope.expectedScopes[0]));
  duplicateScope.scopes.push(structuredClone(duplicateScope.scopes[0]));
  assert.match(
    auditor.auditWecomReceipt('duplicate-scope', auditLine(duplicateScope), requirement, new Date(2026, 8, 9, 20, 0, 0))[0],
    /duplicate scope|重复.*scope/i,
  );
});

test('legacy arithmetic checks every ledger and does not skip a zero done-line mismatch', () => {
  const auditor = new ReportAuditor();
  const warnings = auditor.audit('phone-1', [
    '核对账：账本1 = 已发1 + 跳过0 + 失败0',
    '核对账：账本3 = 已发1 + 跳过0 + 失败0',
  ].join('\n'), NOW);
  assert.equal(warnings.length, 3);
  assert.ok(warnings.some((warning) => /逐卡行有0张.*已发1/.test(warning)));
  assert.ok(warnings.some((warning) => /账本3 ≠ 已发1/.test(warning)));
});

test('structured sent dedup uses full identity, time, and summary while already_sent never claims this run sent it', () => {
  const requirement = { date: '2026-09-09', requiredChannels: ['mass_send', 'moments'] };
  const first = new ReportAuditor();
  assert.deepEqual(
    first.auditWecomReceipt('phone-1', auditLine(receiptFixture), requirement, new Date(2026, 8, 9, 20, 0, 0)),
    [],
  );
  assert.match(
    first.auditWecomReceipt('phone-1', auditLine(receiptFixture), requirement, new Date(2026, 8, 9, 20, 1, 0))[0],
    /重复|已在其他任务/i,
  );

  const otherIdentity = structuredClone(receiptFixture);
  for (const scope of otherIdentity.expectedScopes) scope.account = 'other-account';
  for (const scope of otherIdentity.scopes) scope.account = 'other-account';
  assert.deepEqual(
    first.auditWecomReceipt('phone-1', auditLine(otherIdentity), requirement, new Date(2026, 8, 9, 20, 2, 0)),
    [],
  );

  const onlyAlreadySent = structuredClone(receiptFixture);
  onlyAlreadySent.scopes[0].cards = onlyAlreadySent.scopes[0].cards.map((card) => ({
    id: card.id,
    date: card.date,
    time: card.time,
    summary: card.summary,
    status: 'already_sent',
    evidence: card.evidence,
    observedStep: card.observedStep,
  }));
  const fresh = new ReportAuditor();
  assert.deepEqual(
    fresh.auditWecomReceipt('phone-1', auditLine(onlyAlreadySent), requirement, new Date(2026, 8, 9, 20, 0, 0)),
    [],
  );
  assert.deepEqual(
    fresh.auditWecomReceipt('phone-1', auditLine(onlyAlreadySent), requirement, new Date(2026, 8, 9, 20, 1, 0)),
    [],
  );
});

test('explicit main and clone scope in the task cannot pass with a main-only receipt', () => {
  const requirement = classifyWecomAuditRequirement(
    '执行主应用和分身今天的1v1任务',
    new Date(2026, 8, 9, 9, 0, 0),
  );
  assert.ok(requirement);
  assert.deepEqual(requirement.requiredInstanceKinds, ['main', 'clone']);
  const mainOnly = structuredClone(receiptFixture);
  mainOnly.requiredChannels = ['mass_send'];
  mainOnly.expectedScopes = mainOnly.expectedScopes.filter((scope) => scope.channel === 'mass_send');
  mainOnly.scopes = mainOnly.scopes.filter((scope) => scope.channel === 'mass_send');
  assert.match(
    new ReportAuditor().auditWecomReceipt(
      'phone-1',
      auditLine(mainOnly),
      requirement,
      new Date(2026, 8, 9, 20, 0, 0),
    )[0],
    /分身|clone|实例/i,
  );
});

test('valid structured receipt bypasses contradictory legacy free-text arithmetic', () => {
  const message = `核对账：账本9 = 已发9 + 跳过0 + 失败0\n${auditLine(receiptFixture)}`;
  assert.deepEqual(new ReportAuditor().audit('phone-1', message, new Date(2026, 8, 9)), []);
});

test('structured sent dedup retains only a bounded number of receipt dates', () => {
  const auditor = new ReportAuditor();
  const forDate = (date) => {
    const receipt = structuredClone(receiptFixture);
    receipt.date = date;
    for (const scope of receipt.scopes) {
      for (const card of scope.cards) card.date = date;
    }
    return receipt;
  };
  for (const day of ['2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09']) {
    assert.deepEqual(
      auditor.auditWecomReceipt(
        'phone-1',
        auditLine(forDate(day)),
        { date: day, requiredChannels: ['mass_send', 'moments'], requiredInstanceKinds: [] },
        new Date(`${day}T12:00:00`),
      ),
      [],
    );
  }
  assert.deepEqual(
    auditor.auditWecomReceipt(
      'phone-1',
      auditLine(forDate('2026-09-06')),
      { date: '2026-09-06', requiredChannels: ['mass_send', 'moments'], requiredInstanceKinds: [] },
      new Date('2026-09-06T13:00:00'),
    ),
    [],
  );
});

test('the orchestrator wording for a main-instance task does not demand a clone', () => {
  // Mirror of the phone-side fix. Every WeCom task names 分身 twice — the badge the
  // target must NOT have, and the account the clone holds — and reading either as
  // "this run must cover a clone" rejected a run that had finished correctly with
  // "[桌面校验] 任务明确要求分身，但收据缺少 clone 实例" (observed 2026-09-11).
  const mainOnly = '在企业微信上执行今天的 1v1 群发和客户朋友圈指派任务。'
    + '先通过 AWAKE 弹窗进入不带分身角标的主应用，打开抽屉逐字核对顶部账号名为「Edith 羊」'
    + '（注意：分身是 Erica羊，进错了要立即退出换主应用）。核对当前企业为「新氧」。';
  const main = classifyWecomAuditRequirement(mainOnly);
  assert.ok(main, 'a WeCom send task must still be recognised');
  assert.ok(!main.requiredInstanceKinds.includes('clone'));
  assert.ok(main.requiredInstanceKinds.includes('main'));

  // A task that really targets a clone still demands one.
  const cloneTask = '进入带分身角标的企微分身，执行今天的 1v1 群发指派任务';
  assert.ok(classifyWecomAuditRequirement(cloneTask).requiredInstanceKinds.includes('clone'));
  const cloneById = '在企微 clone1 实例里执行今天的客户朋友圈指派任务，主应用已完成';
  assert.ok(classifyWecomAuditRequirement(cloneById).requiredInstanceKinds.includes('clone'));
});

test('device completion-gate annotation is a contradiction, unresolved incident is only unverifiable', async () => {
  const { judgeReport, isDeviceGateWarning } = await import('../dist/report-audit.js');
  const auditor = new ReportAuditor();

  const gate = '浏览完成\n[设备校验] 进展账本 3/10，汇报声称 10';
  const gateWarnings = auditor.audit('dev-1', gate, NOW);
  assert.equal(gateWarnings.length, 1);
  assert.ok(isDeviceGateWarning(gateWarnings[0]));
  assert.match(gateWarnings[0], /进展账本 3\/10，汇报声称 10/);
  assert.equal(judgeReport(gate, gateWarnings).verdict, 'contradicted');

  const collected = '调研完成\n[设备校验] 进展账本 6/10，系统收集 6 条，汇报声称 10';
  assert.equal(auditor.audit('dev-1', collected, NOW).length, 1);

  const unresolved = '完成\n[设备校验] 结束时仍有未解决的问题：第12步 CLICK 无效果（已尝试 2 次）';
  assert.deepEqual(auditor.audit('dev-1', unresolved, NOW), []);
  const judgement = judgeReport(unresolved, []);
  assert.equal(judgement.verdict, 'unverifiable');
  assert.match(judgement.basis[0], /未解决的问题/);
});

test('claims without any receipt or reconciliation are unverifiable, not contradicted', async () => {
  const { judgeReport } = await import('../dist/report-audit.js');
  assert.equal(judgeReport('已发送 5 张', []).verdict, 'unverifiable');
  assert.equal(judgeReport(`已发送 5 张\n${RECEIPT(9)}`, []).verdict, 'consistent');
  assert.equal(judgeReport('浏览了 10 篇笔记', []).verdict, 'consistent');
  assert.equal(judgeReport('已发送 5 张', ['[桌面校验] x']).verdict, 'contradicted');
});
