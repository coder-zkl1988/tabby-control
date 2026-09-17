import assert from 'node:assert/strict';
import test from 'node:test';

import { Orchestrator } from '../dist/orchestrator.js';

test('legacy orchestration rejects assigned WeCom execution before task.start', async () => {
  const calls = [];
  const coordinator = {
    async sendTaskStart() {
      calls.push('task.start');
    },
    async sendTaskEnd() {
      calls.push('task.end');
    },
    async executeSubTask() {
      calls.push('subtask.execute');
      return { status: 'success', screenshot: undefined };
    },
  };
  const orchestrator = new Orchestrator(coordinator);
  await assert.rejects(
    orchestrator.executeSkillTask(
      'phone-1',
      '在三台名称为企微专用的手机上执行1v1任务和朋友圈任务',
      [{ name: '执行今天任务', type: 'flexible' }],
    ),
    /WECOM_AUDIT_UNSUPPORTED_ENTRY/,
  );
  assert.deepEqual(calls, []);
});
