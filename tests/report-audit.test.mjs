import assert from 'node:assert/strict';
import test from 'node:test';

import { ReportAuditor, extractClaimedCount } from '../dist/report-audit.js';

const NOW = new Date(2026, 8, 4, 14, 0, 0); // 本地 2026-09-04 14:00
const RECEIPT = (n) => `[回执] 各应用生效点击: com.tencent.wework=${n}`;

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
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /核对账不平：账本3 ≠ 已发2 \+ 跳过0 \+ 失败0/);
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

test('claims exceeding the receipt warn as untrusted; claims within it pass', () => {
  const auditor = new ReportAuditor();
  const bad = auditor.audit('22101317C', `发送2张（当天待发卡片）\n${RECEIPT(1)}`, NOW);
  assert.equal(bad.length, 1);
  assert.match(bad[0], /声称已发送\/已发表2张 > 回执生效点击1次/);
  assert.deepEqual(auditor.audit('22101317C', `已发送 2 张；已发表 1 张\n${RECEIPT(5)}`, NOW), []);
});

test('same card reported done twice in a day on one device warns; other channel or device does not', () => {
  const auditor = new ReportAuditor();
  const sent = '卡片1 | 上方时间标注=下午 3:38 | 摘要=Knock! 羊的械2卫生 | 分类=今天已发送';
  const published = '卡片1 | 日期时间=09月04日10:33 | 摘要=Knock! 羊的械2卫生 | 分类=今天已发表';
  assert.deepEqual(auditor.audit('0356', sent, NOW), []);
  // 同文案走朋友圈渠道不算重复（同一份文案常同时下发两个渠道）
  assert.deepEqual(auditor.audit('0356', published, NOW), []);
  const dup = auditor.audit('0356', sent, NOW);
  assert.equal(dup.length, 1);
  assert.match(dup[0], /当日已被其他轮次汇报为已发送/);
  // 其他设备同卡不误报
  assert.deepEqual(auditor.audit('376e', sent, NOW), []);
});

test('skipped cards never enter the dedup set', () => {
  const auditor = new ReportAuditor();
  const skipped = '卡片1 | 上方时间标注=昨天 | 摘要=Hannah羊通知 | 分类=跳过(早于今天)';
  assert.deepEqual(auditor.audit('0356', skipped, NOW), []);
  assert.deepEqual(auditor.audit('0356', skipped, NOW), []);
});

test('dedup memory rolls over on the LOCAL date, not UTC', () => {
  const auditor = new ReportAuditor();
  const msg = '卡片1 | 时间标注=下午 3:38 | 摘要=Knock! 羊的械 | 分类=今天已发送';
  // 本地 09-04 07:00 与 09:00 是同一天（UTC 里跨了 23:00→01:00 的日界）
  assert.deepEqual(auditor.audit('0356', msg, new Date(2026, 8, 4, 7, 0, 0)), []);
  assert.equal(auditor.audit('0356', msg, new Date(2026, 8, 4, 9, 0, 0)).length, 1);
  // 本地次日清零
  assert.deepEqual(auditor.audit('0356', msg, new Date(2026, 8, 5, 9, 0, 0)), []);
});

test('literal backslash-n newlines are normalized before per-card matching', () => {
  const auditor = new ReportAuditor();
  const msg = '已发送 1 张\\n卡片1 | 上方时间标注=下午 3:38 | 摘要=Knock! 羊的械 | 分类=今天已发送\\n核对账：账本1 = 已发1 + 跳过0 + 失败0';
  assert.deepEqual(auditor.audit('0356', msg, NOW), []);
  // 第二轮同卡：逐卡行被正确切出并计入去重
  assert.equal(auditor.audit('0356', msg, NOW).length, 1);
});
