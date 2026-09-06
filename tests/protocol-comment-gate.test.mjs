import assert from 'node:assert/strict';
import test from 'node:test';

import { TaskPolicySchema } from '../dist/protocol.js';

// xhs-ops P3-1 评论门禁：默认 forbidden；只有带白名单的 allowed 才是合法放宽。
test('comment gate: allowed with an allowlist passes through to the phone verbatim', () => {
  const policy = TaskPolicySchema.parse({
    operationClass: 'app.use.xhs',
    confirmationPolicy: { publish: 'forbidden', payment: 'forbidden', comment: 'allowed' },
    commentAllowlist: ['儿童用品齐全太省心'],
  });
  assert.equal(policy.confirmationPolicy.comment, 'allowed');
  assert.deepEqual(policy.commentAllowlist, ['儿童用品齐全太省心']);
});

test('comment gate: allowed without an allowlist is rejected at dispatch', () => {
  assert.throws(
    () => TaskPolicySchema.parse({
      confirmationPolicy: { comment: 'allowed' },
    }),
    /commentAllowlist/,
  );
});

test('comment gate: allowlist is capped at 5 texts of at most 30 chars', () => {
  assert.throws(() => TaskPolicySchema.parse({
    confirmationPolicy: { comment: 'allowed' },
    commentAllowlist: ['一', '二', '三', '四', '五', '六'],
  }));
  assert.throws(() => TaskPolicySchema.parse({
    confirmationPolicy: { comment: 'allowed' },
    commentAllowlist: ['这一条评论实在是太长了'.padEnd(31, '长')],
  }));
});

test('comment gate: policies without the field still parse (browse tasks stay forbidden by default on the phone)', () => {
  const policy = TaskPolicySchema.parse({ confirmationPolicy: { publish: 'forbidden' } });
  assert.equal(policy.confirmationPolicy.comment, undefined);
  assert.equal(policy.commentAllowlist, undefined);
});
