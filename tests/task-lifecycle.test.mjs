import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_CLOSED_TASKS, TaskCoordinator } from '../dist/task-coordinator.js';
import {
  createCancelTaskTool,
  createExecuteBatchTool,
  createExecuteTaskTool,
  createGetTaskResultsTool,
} from '../dist/tools.js';

const DEVICE_ID = 'phone-1';

/** Stands in for what a connected phone reports at auth. */
const DEFAULT_VOCABULARY = {
  actions: new Set([
    'CLICK', 'TYPE', 'SLIDE', 'AWAKE', 'BACK', 'HOME', 'WAIT',
    'INFO', 'CALL_USER', 'COMPLETE', 'ABORT',
  ]),
  aliases: { TAP: 'CLICK', SWIPE: 'SLIDE', LAUNCH: 'AWAKE' },
};

/** Pass `actionVocabulary: null` to model a phone that reported none. */
function createHarness({ actionVocabulary = DEFAULT_VOCABULARY } = {}) {
  const device = {
    info: {
      deviceId: DEVICE_ID,
      model: 'Test Phone',
      status: 'idle',
      connectedAt: Date.now(),
      lastSeen: Date.now(),
    },
    actionVocabulary: actionVocabulary ?? undefined,
  };
  const sent = [];
  const notified = [];
  const registry = {
    get(deviceId) {
      return deviceId === DEVICE_ID ? device : undefined;
    },
    list() {
      return [device.info];
    },
    updateStatus(deviceId, patch) {
      assert.equal(deviceId, DEVICE_ID);
      device.info = { ...device.info, ...patch };
    },
  };
  const wsServer = {
    getRegistry() {
      return registry;
    },
    sendToDevice(deviceId, message) {
      sent.push({ deviceId, message });
      return true;
    },
  };

  return {
    coordinator: new TaskCoordinator(wsServer, (channel, data) => notified.push({ channel, data })),
    device,
    notified,
    sent,
  };
}

function executeMessage(sent, index = 0) {
  return sent.filter(({ message }) => message.method === 'agent.execute')[index].message;
}

function cancelMessage(sent) {
  return sent.filter(({ message }) => message.method === 'agent.cancel').at(-1)?.message;
}

test('cancel current targets the actual running task and rejects its waiter', async () => {
  const { coordinator, sent } = createHarness();
  const taskPromise = coordinator.executeTask(DEVICE_ID, 'long task', 1_000);
  const observedTask = taskPromise.catch((error) => error);
  const taskId = executeMessage(sent).params.taskId;

  try {
    coordinator.cancelTask(DEVICE_ID, 'current');
    assert.equal(cancelMessage(sent).params.taskId, taskId);
    assert.match((await observedTask).message, /CANCELLED/);
  } finally {
    if (cancelMessage(sent)?.params.taskId !== taskId) {
      coordinator.cancelTask(DEVICE_ID, taskId);
    }
  }
});

test('structured task policy reaches the phone unchanged', async () => {
  const { coordinator, sent } = createHarness();
  const policy = {
    operationClass: 'app.install',
    targetPackages: ['com.xingin.xhs'],
    allowedAppRoles: ['target_app', 'official_store', 'system_installer'],
    installSourcePolicy: 'official_store_only',
    allowBrowserDownload: false,
    confirmationPolicy: {
      payment: 'forbidden',
    },
  };
  const taskPromise = coordinator.executeTask(
    DEVICE_ID,
    'install xhs',
    1_000,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    policy,
  );
  const observed = taskPromise.catch((error) => error);

  assert.deepEqual(executeMessage(sent).params.taskPolicy, policy);
  coordinator.cancelTask(DEVICE_ID, 'current');
  assert.match((await observed).message, /CANCELLED/);
});

test('unsafe desktop policy is rejected before the device becomes busy', async () => {
  const { coordinator, device, sent } = createHarness();

  await assert.rejects(
    coordinator.executeTask(
      DEVICE_ID,
      'install xhs',
      1_000,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        operationClass: 'app.install',
        allowBrowserDownload: true,
      },
    ),
    /安装任务禁止浏览器下载/,
  );
  assert.equal(device.info.status, 'idle');
  assert.equal(sent.length, 0);
});

test('runtime progress is retained on the device status', async () => {
  const { coordinator, device, sent } = createHarness();
  const taskPromise = coordinator.executeTask(DEVICE_ID, 'search xhs', 1_000);
  const observed = taskPromise.catch((error) => error);
  const taskId = executeMessage(sent).params.taskId;

  coordinator.handleTaskMessage(DEVICE_ID, {
    method: 'agent.progress',
    params: {
      taskId,
      step: 1,
      runtime: {
        operationClass: 'content.search',
        currentAppRole: 'target_app',
        selectedSkills: ['android-core-v1', 'xiaomi-hyperos-v1', 'xhs-v18'],
        skippedSkills: ['android-media-picker-v1'],
        skillLayerMode: 'shadow',
        policyMode: 'audit',
        policyDecision: 'allow',
      },
    },
  });

  try {
    assert.equal(device.info.currentOperationClass, 'content.search');
    assert.equal(device.info.currentAppRole, 'target_app');
    assert.deepEqual(device.info.activeSkills, [
      'android-core-v1',
      'xiaomi-hyperos-v1',
      'xhs-v18',
    ]);
    assert.deepEqual(device.info.skippedSkills, ['android-media-picker-v1']);
    assert.equal(device.info.deviceSkillLayerMode, 'shadow');
    assert.equal(device.info.devicePolicyMode, 'audit');
    assert.equal(device.info.lastPolicyDecision, 'allow');
  } finally {
    coordinator.cancelTask(DEVICE_ID, 'current');
    assert.match((await observed).message, /CANCELLED/);
  }
});

test('structured policy block is retained on the device status', async () => {
  const { coordinator, device, sent } = createHarness();
  const taskPromise = coordinator.executeTask(DEVICE_ID, 'install xhs', 1_000);
  const taskId = executeMessage(sent).params.taskId;

  coordinator.handleTaskMessage(DEVICE_ID, {
    id: `resp_${taskId}`,
    result: {
      taskId,
      success: false,
      status: 'blocked',
      message: 'POLICY_BROWSER_INSTALL_FORBIDDEN: browser is not an official store',
      errorCode: 'POLICY_BROWSER_INSTALL_FORBIDDEN',
      policyDecision: 'block',
      blockReason: 'browser is not an official store',
      totalSteps: 1,
    },
  });

  const result = await taskPromise;
  assert.equal(result.status, 'blocked');
  assert.equal(device.info.lastPolicyDecision, 'block');
  assert.equal(device.info.lastPolicyCode, 'POLICY_BROWSER_INSTALL_FORBIDDEN');
  assert.equal(device.info.lastBlockedReason, 'browser is not an official store');
});

test('interaction keeps the original task busy and cancellable', async () => {
  const { coordinator, device, sent } = createHarness();
  const taskPromise = coordinator.executeTask(DEVICE_ID, 'task needing input', 1_000);
  const taskId = executeMessage(sent).params.taskId;

  coordinator.handleTaskMessage(DEVICE_ID, {
    method: 'agent.progress',
    params: {
      taskId,
      step: 1,
      interaction_request: { message: 'Need a phone number' },
    },
  });

  const interaction = await taskPromise;
  assert.equal(interaction.needsInteraction, true);

  try {
    assert.equal(device.info.status, 'busy');
    assert.equal(device.info.currentTaskId, taskId);
    coordinator.cancelTask(DEVICE_ID, 'current');
    assert.equal(cancelMessage(sent).params.taskId, taskId);
  } finally {
    if (cancelMessage(sent)?.params.taskId !== taskId) {
      coordinator.cancelTask(DEVICE_ID, taskId);
    }
  }
});

test('guidance resume awaits the original task result, not the transport ack', async () => {
  const { coordinator, device, sent } = createHarness();
  const originalPromise = coordinator.executeTask(DEVICE_ID, 'task needing input', 1_000);
  const originalTaskId = executeMessage(sent).params.taskId;

  coordinator.handleTaskMessage(DEVICE_ID, {
    method: 'agent.progress',
    params: {
      taskId: originalTaskId,
      step: 1,
      interaction_request: { message: 'Need a phone number' },
    },
  });
  const interaction = await originalPromise;
  assert.equal(interaction.needsInteraction, true);

  const resumePromise = coordinator.executeTask(
    DEVICE_ID,
    'task needing input',
    1_000,
    'Use 18500000000',
    originalTaskId,
  );
  let resumeSettled = false;
  resumePromise.then(() => { resumeSettled = true; }, () => { resumeSettled = true; });
  const resumeTaskId = executeMessage(sent, 1).params.taskId;

  // The phone's transport-level "guidance received" reply must NOT settle the
  // resume call — it is acked back to the phone and otherwise suppressed.
  coordinator.handleTaskMessage(DEVICE_ID, {
    id: `resp_${resumeTaskId}`,
    result: {
      taskId: resumeTaskId,
      success: true,
      message: 'Guidance received',
      status: 'completed',
      totalSteps: 0,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resumeSettled, false);
  const transportAck = sent
    .filter(({ message }) => message.method === 'agent.result_ack')
    .at(-1);
  assert.equal(transportAck.message.params.taskId, resumeTaskId);
  assert.equal(device.info.status, 'busy');
  assert.equal(device.info.currentTaskId, originalTaskId);

  // The ORIGINAL task's terminal result is what resolves the resume call.
  coordinator.handleTaskMessage(DEVICE_ID, {
    id: `resp_${originalTaskId}`,
    result: {
      taskId: originalTaskId,
      success: true,
      message: '任务完成：已输入 18500000000 并提交',
      status: 'completed',
      totalSteps: 7,
    },
  });
  const finalResult = await resumePromise;
  assert.equal(finalResult.message, '任务完成：已输入 18500000000 并提交');
  assert.equal(finalResult.totalSteps, 7);
  assert.equal(device.info.status, 'idle');
});

test('late guidance for a finished task returns the retained result instead of re-running', async () => {
  const { coordinator, sent } = createHarness();
  const originalPromise = coordinator.executeTask(DEVICE_ID, 'task needing input', 1_000);
  const originalTaskId = executeMessage(sent).params.taskId;

  coordinator.handleTaskMessage(DEVICE_ID, {
    method: 'agent.progress',
    params: {
      taskId: originalTaskId,
      step: 1,
      interaction_request: { message: 'Which entry?' },
    },
  });
  await originalPromise;

  // The phone's 60s window expires and the loop finishes on its own; its
  // result arrives with no waiter and is retained for recovery.
  coordinator.handleTaskMessage(DEVICE_ID, {
    id: `resp_${originalTaskId}`,
    result: {
      taskId: originalTaskId,
      success: true,
      message: '自行完成：没有新消息',
      status: 'completed',
      totalSteps: 5,
    },
  });

  const executesBefore = sent.filter(({ message }) => message.method === 'agent.execute').length;
  const lateResult = await coordinator.executeTask(
    DEVICE_ID,
    'task needing input',
    1_000,
    '选第一个入口',
    originalTaskId,
  );
  const executesAfter = sent.filter(({ message }) => message.method === 'agent.execute').length;

  assert.equal(executesAfter, executesBefore);
  assert.match(lateResult.message, /NOT applied/);
  assert.match(lateResult.message, /自行完成：没有新消息/);
  assert.equal(lateResult.totalSteps, 5);
});

test('a second resume while one is in flight is rejected', async () => {
  const { coordinator, sent } = createHarness();
  const originalPromise = coordinator.executeTask(DEVICE_ID, 'task needing input', 1_000);
  const originalTaskId = executeMessage(sent).params.taskId;

  coordinator.handleTaskMessage(DEVICE_ID, {
    method: 'agent.progress',
    params: {
      taskId: originalTaskId,
      step: 1,
      interaction_request: { message: 'Q' },
    },
  });
  await originalPromise;

  const resume1 = coordinator.executeTask(
    DEVICE_ID, 'task needing input', 1_000, 'A', originalTaskId,
  );
  const observed1 = resume1.catch((error) => error);

  await assert.rejects(
    coordinator.executeTask(DEVICE_ID, 'task needing input', 1_000, 'B', originalTaskId),
    /RESUME_IN_FLIGHT/,
  );

  coordinator.handleTaskMessage(DEVICE_ID, {
    id: `resp_${originalTaskId}`,
    result: {
      taskId: originalTaskId,
      success: true,
      message: 'done',
      status: 'completed',
      totalSteps: 2,
    },
  });
  assert.equal((await observed1).message, 'done');
});

test('authoritative idle reconnect drops stale tracking without clearing a newer task', async () => {
  const { coordinator, device, sent } = createHarness();
  const firstPromise = coordinator.executeTask(DEVICE_ID, 'old task', 1_000);
  void firstPromise.catch(() => {});
  const firstTaskId = executeMessage(sent).params.taskId;

  device.info = {
    ...device.info,
    status: 'idle',
    currentTaskId: undefined,
  };

  const secondPromise = coordinator.executeTask(DEVICE_ID, 'new task', 1_000);
  const observedSecond = secondPromise.catch((error) => error);
  const secondTaskId = executeMessage(sent, 1).params.taskId;

  coordinator.handleTaskMessage(DEVICE_ID, {
    id: `resp_${firstTaskId}`,
    result: {
      taskId: firstTaskId,
      success: true,
      message: 'Late old result',
      status: 'completed',
      totalSteps: 1,
    },
  });
  await firstPromise;

  try {
    assert.equal(device.info.status, 'busy');
    assert.equal(device.info.currentTaskId, secondTaskId);
  } finally {
    coordinator.cancelTask(DEVICE_ID, 'current');
    assert.match((await observedSecond).message, /CANCELLED/);
  }
});

test('late progress from a cancelled task cannot resurrect or replace task ownership', async () => {
  const { coordinator, device, sent } = createHarness();
  const oldPromise = coordinator.executeTask(DEVICE_ID, 'old task', 1_000);
  const observedOld = oldPromise.catch((error) => error);
  const oldTaskId = executeMessage(sent).params.taskId;

  coordinator.cancelTask(DEVICE_ID, oldTaskId);
  assert.match((await observedOld).message, /CANCELLED/);
  assert.equal(device.info.status, 'idle');

  coordinator.handleTaskMessage(DEVICE_ID, {
    method: 'agent.progress',
    params: {
      taskId: oldTaskId,
      step: 99,
      runtime: {
        operationClass: 'stale.operation',
        currentAppRole: 'browser',
      },
    },
  });
  assert.equal(device.info.status, 'idle');
  assert.equal(device.info.currentTaskId, undefined);
  assert.notEqual(device.info.currentOperationClass, 'stale.operation');

  const newPromise = coordinator.executeTask(DEVICE_ID, 'new task', 1_000);
  const observedNew = newPromise.catch((error) => error);
  const newTaskId = executeMessage(sent, 1).params.taskId;

  coordinator.handleTaskMessage(DEVICE_ID, {
    method: 'agent.progress',
    params: {
      taskId: oldTaskId,
      step: 100,
      runtime: {
        operationClass: 'stale.operation',
        currentAppRole: 'browser',
      },
    },
  });

  try {
    assert.equal(device.info.status, 'busy');
    assert.equal(device.info.currentTaskId, newTaskId);
    assert.notEqual(device.info.currentOperationClass, 'stale.operation');
    coordinator.cancelTask(DEVICE_ID, 'current');
    assert.equal(cancelMessage(sent).params.taskId, newTaskId);
    assert.match((await observedNew).message, /CANCELLED/);
  } finally {
    if (device.info.status === 'busy') coordinator.cancelTask(DEVICE_ID, newTaskId);
  }
});

test('batch interaction output includes the resume contract', async () => {
  const tool = createExecuteBatchTool({
    executeBatch: async () => ({
      [DEVICE_ID]: {
        taskId: 't_paused',
        success: false,
        message: 'Need a phone number',
        needsInteraction: true,
        interactionMessage: 'Need a phone number',
      },
    }),
  });

  const result = await tool.execute('call-1', {
    tasks: [{ deviceId: DEVICE_ID, task: 'login' }],
  });
  const output = result.content[0].text;

  assert.match(output, /sessionId: "t_paused"/);
  assert.match(output, /guidance/);
});

test('execute tool preserves structured policy block details', async () => {
  const tool = createExecuteTaskTool({
    executeTask: async () => ({
      taskId: 't_blocked',
      success: false,
      status: 'blocked',
      message: 'POLICY_BROWSER_INSTALL_FORBIDDEN: action=AWAKE',
      errorCode: 'POLICY_BROWSER_INSTALL_FORBIDDEN',
      policyDecision: 'block',
      blockReason: 'action=AWAKE',
      totalSteps: 1,
    }),
  });

  const result = await tool.execute('call-1', {
    deviceId: DEVICE_ID,
    task: 'install xhs',
  });
  const output = result.content[0].text;

  assert.equal(result.isError, true);
  assert.match(output, /Policy code: POLICY_BROWSER_INSTALL_FORBIDDEN/);
  assert.match(output, /Policy reason: action=AWAKE/);
});

test('a result nobody is awaiting is cached so an aborted call can recover it', async () => {
  const { coordinator, sent } = createHarness();
  const taskPromise = coordinator.executeTask(DEVICE_ID, 'browse 10 posts', 1_000);
  const observed = taskPromise.catch((error) => error);
  const taskId = executeMessage(sent).params.taskId;

  // The caller goes away (aborted HTTP request) before the phone answers.
  coordinator.cancelTask(DEVICE_ID, 'current');
  assert.match((await observed).message, /CANCELLED/);

  // The phone's result lands with nobody left to receive it.
  coordinator.handleTaskMessage(DEVICE_ID, {
    id: `resp_${taskId}`,
    result: {
      taskId,
      success: true,
      message: 'Late but complete',
      status: 'completed',
      totalSteps: 12,
    },
  });

  const cached = coordinator.getTaskResult(taskId);
  assert.equal(cached?.orphaned, true);
  assert.equal(cached?.deviceId, DEVICE_ID);
  assert.equal(cached?.result.message, 'Late but complete');
  assert.deepEqual(
    coordinator.getRecentTaskResults(DEVICE_ID).map((entry) => entry.taskId),
    [taskId],
  );
});

test('a delivered result is cached without being marked orphaned', async () => {
  const { coordinator, sent } = createHarness();
  const taskPromise = coordinator.executeTask(DEVICE_ID, 'quick task', 1_000);
  const taskId = executeMessage(sent).params.taskId;

  coordinator.handleTaskMessage(DEVICE_ID, {
    id: `resp_${taskId}`,
    result: {
      taskId,
      success: true,
      message: 'Collected by the caller',
      status: 'completed',
      totalSteps: 1,
    },
  });
  await taskPromise;

  assert.equal(coordinator.getTaskResult(taskId)?.orphaned, false);
  assert.equal(coordinator.getTaskResult('t_never_ran'), null);
});

test('terminal results are acknowledged and replayed results are idempotent', async () => {
  const { coordinator, notified, sent } = createHarness();
  const taskPromise = coordinator.executeTask(DEVICE_ID, 'quick task', 1_000);
  const taskId = executeMessage(sent).params.taskId;
  const resultMessage = {
    id: `resp_${taskId}`,
    result: {
      taskId,
      success: true,
      message: 'Delivered once',
      status: 'completed',
      totalSteps: 1,
    },
  };

  coordinator.handleTaskMessage(DEVICE_ID, resultMessage);
  await taskPromise;
  coordinator.handleTaskMessage(DEVICE_ID, resultMessage);

  const acknowledgements = sent.filter(({ message }) =>
    message.method === 'agent.result_ack' && message.params.taskId === taskId
  );
  assert.equal(acknowledgements.length, 2);
  assert.equal(
    notified.filter(({ channel }) => channel === 'device:task_result').length,
    1,
  );
  assert.equal(coordinator.getTaskResult(taskId)?.orphaned, false);
});

test('the recovery tool surfaces an uncollected result and its query', async () => {
  const queries = [];
  const tool = createGetTaskResultsTool({
    getTaskResults: async (query) => {
      queries.push(query);
      return query.deviceId === DEVICE_ID
        ? [{
          taskId: 't_lost',
          deviceId: DEVICE_ID,
          completedAt: Date.now() - 5_000,
          orphaned: true,
          result: {
            taskId: 't_lost',
            success: true,
            status: 'completed',
            message: '浏览了 10 篇羽毛球笔记',
            totalSteps: 42,
          },
        }]
        : [];
    },
  });

  const recovered = await tool.execute('call-1', { deviceId: DEVICE_ID });
  assert.equal(recovered.isError, undefined);
  assert.match(recovered.content[0].text, /result was never collected/);
  assert.match(recovered.content[0].text, /浏览了 10 篇羽毛球笔记/);
  assert.deepEqual(queries, [{ taskId: undefined, deviceId: DEVICE_ID, limit: undefined }]);

  const empty = await tool.execute('call-2', { deviceId: 'phone-unknown' });
  assert.equal(empty.isError, undefined);
  assert.match(empty.content[0].text, /No retained task results match/);
});

test('an orphaned caller-disconnect result retains its source and duration', async () => {
  const { coordinator, sent } = createHarness();
  const taskPromise = coordinator.executeTask(DEVICE_ID, 'long task', 1_000);
  const observed = taskPromise.catch((error) => error);
  const taskId = executeMessage(sent).params.taskId;

  coordinator.cancelTask(DEVICE_ID, 'current', 'caller_disconnected');
  assert.match((await observed).message, /CANCELLED/);
  coordinator.handleTaskMessage(DEVICE_ID, {
    id: `resp_${taskId}`,
    result: {
      taskId,
      success: false,
      status: 'aborted',
      message: 'Task cancelled before completion',
      totalSteps: 2,
      duration: 16_921,
    },
  });

  const tool = createGetTaskResultsTool({
    getTaskResults: async () => [coordinator.getTaskResult(taskId)],
  });
  const recovered = await tool.execute('call-1', { taskId });

  assert.match(recovered.content[0].text, /CALLER_DISCONNECTED/);
  assert.match(recovered.content[0].text, /caller disconnect, not an on-device model decision/);
  assert.match(recovered.content[0].text, /Duration: 16\.9s/);
});

test('cancellation sources are pruned with their closed task ids', async () => {
  const { coordinator, sent } = createHarness();
  const taskIds = [];

  // Derived from the cap rather than hardcoded: the bound is sized for a
  // fleet-wide dispatch and will change again as fleets grow.
  for (let index = 0; index < MAX_CLOSED_TASKS + 1; index += 1) {
    const taskPromise = coordinator.executeTask(DEVICE_ID, `task ${index}`, 1_000);
    const observed = taskPromise.catch((error) => error);
    taskIds.push(sent.at(-1).message.params.taskId);
    coordinator.cancelTask(DEVICE_ID, 'current', 'caller_disconnected');
    await observed;
  }

  assert.equal(coordinator.taskCancellationSources.has(taskIds[0]), false);
  assert.equal(coordinator.taskCancellationSources.has(taskIds.at(-1)), true);
});

test('cancel tool defaults to the current task', async () => {
  const calls = [];
  const tool = createCancelTaskTool({
    cancelTask: async (deviceId, taskId) => calls.push({ deviceId, taskId }),
  });

  const result = await tool.execute('call-1', { deviceId: DEVICE_ID });

  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ deviceId: DEVICE_ID, taskId: 'current' }]);
});

test('an under-specified action whitelist still lets the agent finish and navigate', async () => {
  const { coordinator, sent } = createHarness();
  // A caller listing only effect actions — the shape an LLM produces when it
  // thinks about taps but not about how the run terminates. Left as-is this
  // bricks the task on the phone with POLICY_ACTION_NOT_ALLOWED: action=COMPLETE.
  const taskPromise = coordinator.executeTask(
    DEVICE_ID,
    'comment on a post',
    1_000,
    undefined,
    undefined,
    undefined,
    ['CLICK', 'TYPE'],
    undefined,
    { allowedActions: ['CLICK', 'TYPE'], operationClass: 'content.comment' },
  );
  const observed = taskPromise.catch((error) => error);

  const { params } = executeMessage(sent);
  for (const action of ['COMPLETE', 'ABORT', 'CALL_USER', 'INFO', 'BACK', 'WAIT']) {
    assert.ok(params.allowedActions.includes(action), `allowedActions missing ${action}`);
    assert.ok(
      params.taskPolicy.allowedActions.includes(action),
      `taskPolicy.allowedActions missing ${action}`,
    );
  }
  // The caller's own entries survive, and nothing is duplicated.
  assert.deepEqual(params.allowedActions.slice(0, 2), ['CLICK', 'TYPE']);
  assert.equal(new Set(params.allowedActions).size, params.allowedActions.length);

  coordinator.cancelTask(DEVICE_ID, 'current');
  assert.match((await observed).message, /CANCELLED/);
});

test('a control action the caller already listed is not appended twice', async () => {
  const { coordinator, sent } = createHarness();
  const taskPromise = coordinator.executeTask(
    DEVICE_ID,
    'browse',
    1_000,
    undefined,
    undefined,
    undefined,
    ['CLICK', 'back', 'COMPLETE'],
  );
  const observed = taskPromise.catch((error) => error);

  const { allowedActions } = executeMessage(sent).params;
  assert.equal(allowedActions.filter((a) => a.toUpperCase() === 'BACK').length, 1);
  assert.equal(allowedActions.filter((a) => a === 'COMPLETE').length, 1);

  coordinator.cancelTask(DEVICE_ID, 'current');
  assert.match((await observed).message, /CANCELLED/);
});

test('caller action names are normalised to what the phone compares against', async () => {
  const { coordinator, sent } = createHarness();
  // Aliases and casing the phone's normalizeActionName() accepts. Sending them
  // raw works, but the whitelist we log and the one the phone applies then
  // differ, which makes a POLICY_ACTION_NOT_ALLOWED impossible to read.
  const taskPromise = coordinator.executeTask(
    DEVICE_ID,
    'browse',
    1_000,
    undefined,
    undefined,
    undefined,
    ['Tap', 'swipe', 'Launch'],
  );
  const observed = taskPromise.catch((error) => error);

  const { allowedActions } = executeMessage(sent).params;
  assert.deepEqual(allowedActions.slice(0, 3), ['CLICK', 'SLIDE', 'AWAKE']);

  coordinator.cancelTask(DEVICE_ID, 'current');
  assert.match((await observed).message, /CANCELLED/);
});

test('an action name the phone does not know is rejected, not silently dropped', async () => {
  const { coordinator, device } = createHarness();
  // The phone intersects the whitelist with its own vocabulary, so "PRESS"
  // would contribute nothing — a whitelist of only such names becomes deny-all.
  await assert.rejects(
    () => coordinator.executeTask(
      DEVICE_ID,
      'browse',
      1_000,
      undefined,
      undefined,
      undefined,
      ['CLICK', 'PRESS'],
    ),
    /PRESS/,
  );
  // Rejected before dispatch, so the device is not left pinned to a phantom task.
  assert.equal(device.info.status, 'idle');
  assert.equal(coordinator.getActiveTaskId(DEVICE_ID), undefined);
});

test('a phone that reported no vocabulary is not validated against a local table', async () => {
  // No reported vocabulary means we do not know this phone's action set. A
  // hardcoded stand-in is exactly the drift the reporting removes, and would
  // reject an action a newer build supports — so pass the whitelist through.
  const { coordinator, sent } = createHarness({ actionVocabulary: null });
  const taskPromise = coordinator.executeTask(
    DEVICE_ID,
    'browse',
    1_000,
    undefined,
    undefined,
    undefined,
    ['CLICK', 'SOME_FUTURE_ACTION'],
  );
  const observed = taskPromise.catch((error) => error);

  const { allowedActions } = executeMessage(sent).params;
  assert.ok(allowedActions.includes('SOME_FUTURE_ACTION'));
  assert.ok(allowedActions.includes('COMPLETE'));

  coordinator.cancelTask(DEVICE_ID, 'current');
  assert.match((await observed).message, /CANCELLED/);
});

test('a task the caller timed out on is still cancellable as current', async () => {
  const { coordinator, device, sent } = createHarness();
  const taskPromise = coordinator.executeTask(DEVICE_ID, 'long task', 40);
  const observed = taskPromise.catch((error) => error);
  const taskId = executeMessage(sent).params.taskId;

  // The caller's wait ends, but by design the phone keeps working.
  assert.match((await observed).message, /TIMEOUT/);

  // The phone says so, and reports itself busy over the control channel.
  coordinator.handleTaskMessage(DEVICE_ID, {
    method: 'agent.progress',
    params: { taskId, step: 4 },
  });
  device.info = { ...device.info, status: 'busy' };

  // Previously this threw TASK_NOT_FOUND: the device could accept no new task
  // yet could not be stopped without a task id the caller no longer had.
  coordinator.cancelTask(DEVICE_ID, 'current');
  assert.equal(cancelMessage(sent).params.taskId, taskId);
});

test('a phone reporting itself idle drops the remembered task', async () => {
  const { coordinator, device, sent } = createHarness();
  const taskPromise = coordinator.executeTask(DEVICE_ID, 'long task', 40);
  const observed = taskPromise.catch((error) => error);
  const taskId = executeMessage(sent).params.taskId;
  assert.match((await observed).message, /TIMEOUT/);

  coordinator.handleTaskMessage(DEVICE_ID, {
    method: 'agent.progress',
    params: { taskId, step: 4 },
  });
  device.info = { ...device.info, status: 'busy' };

  // The phone going idle over the control channel is authoritative: the task
  // ended on its own. The remembered id must not linger, or a later 'current'
  // would cancel something that already finished.
  device.info = { ...device.info, status: 'idle' };

  assert.throws(() => coordinator.cancelTask(DEVICE_ID, 'current'), /TASK_NOT_FOUND/);
});

test('a large fan-out does not evict the earliest devices\' results', async () => {
  // The failure this guards: with a single global cap of N, a fan-out across
  // more than N phones drops the first finishers before the caller collects
  // them — and a missing result is indistinguishable from one that aged out.
  const { coordinator } = createHarness();
  const FLEET = 200;

  for (let i = 0; i < FLEET; i += 1) {
    coordinator.rememberTaskResult(
      `t_fanout_${i}`,
      `phone-${i}`,
      { taskId: `t_fanout_${i}`, success: true, message: `done ${i}` },
      true,
    );
  }

  // Every device must still have its own result, including the first to report.
  for (const i of [0, 1, FLEET / 2, FLEET - 1]) {
    const found = coordinator.getTaskResult(`t_fanout_${i}`);
    assert.ok(found, `result for phone-${i} was evicted`);
    assert.equal(found.deviceId, `phone-${i}`);
  }
});

test('one busy device cannot crowd out the rest of the fleet', async () => {
  const { coordinator } = createHarness();

  // One device reports far more results than its allowance...
  for (let i = 0; i < 50; i += 1) {
    coordinator.rememberTaskResult(
      `t_chatty_${i}`,
      'phone-chatty',
      { taskId: `t_chatty_${i}`, success: true, message: `chatty ${i}` },
      true,
    );
  }
  // ...and a quiet device reports once, before being followed by many others.
  coordinator.rememberTaskResult(
    't_quiet',
    'phone-quiet',
    { taskId: 't_quiet', success: true, message: 'quiet' },
    true,
  );
  for (let i = 50; i < 100; i += 1) {
    coordinator.rememberTaskResult(
      `t_chatty_${i}`,
      'phone-chatty',
      { taskId: `t_chatty_${i}`, success: true, message: `chatty ${i}` },
      true,
    );
  }

  assert.ok(coordinator.getTaskResult('t_quiet'), 'quiet device lost its only result');
  // The chatty device is trimmed to its own allowance, keeping the newest.
  assert.equal(coordinator.getTaskResult('t_chatty_0'), null);
  assert.ok(coordinator.getTaskResult('t_chatty_99'));
});

test('dispatch returns at once instead of waiting for the fleet', async () => {
  const { coordinator, sent } = createHarness();

  const before = Date.now();
  const { jobId, deviceCount } = coordinator.dispatchTasks(
    [{ deviceId: DEVICE_ID, task: 'long sweep' }],
    60_000,
  );
  const elapsed = Date.now() - before;

  // The phone has not answered and will not for minutes; the call is already back.
  assert.equal(deviceCount, 1);
  assert.ok(elapsed < 100, `dispatch blocked for ${elapsed}ms`);
  assert.equal(executeMessage(sent).params.task, 'long sweep');

  const status = coordinator.getJobStatus(jobId);
  assert.equal(status.total, 1);
  assert.equal(status.running, 1);
  assert.equal(status.done, false);

  coordinator.cancelJob(jobId);
});

test('a job reports each device outcome as it settles', async () => {
  const { coordinator, sent } = createHarness();
  const { jobId } = coordinator.dispatchTasks([{ deviceId: DEVICE_ID, task: 'sweep' }], 60_000);
  const taskId = executeMessage(sent).params.taskId;

  coordinator.handleTaskMessage(DEVICE_ID, {
    id: `resp_${taskId}`,
    result: { taskId, success: true, message: '2 replies sent', totalSteps: 9 },
  });
  await new Promise((resolve) => setImmediate(resolve));

  const status = coordinator.getJobStatus(jobId, { includeResults: true });
  assert.equal(status.done, true);
  assert.equal(status.succeeded, 1);
  assert.equal(status.failed, 0);
  assert.equal(status.results[0].message, '2 replies sent');
});

test('a job summarises rather than returning every device transcript', async () => {
  const { coordinator } = createHarness();
  // Stand in for a fleet: register states directly, since the harness has one device.
  const job = { jobId: 'job_fake', createdAt: Date.now(), devices: new Map() };
  for (let i = 0; i < 300; i += 1) {
    job.devices.set(`phone-${i}`, {
      deviceId: `phone-${i}`,
      taskId: `t_${i}`,
      status: i < 280 ? 'succeeded' : 'failed',
      result: { taskId: `t_${i}`, success: i < 280, message: `transcript ${i}` },
      error: i < 280 ? undefined : `boom ${i}`,
    });
  }
  coordinator.jobs.set('job_fake', job);

  const summary = coordinator.getJobStatus('job_fake');
  assert.equal(summary.total, 300);
  assert.equal(summary.succeeded, 280);
  assert.equal(summary.failed, 20);
  // Failures are listed (they are what a caller acts on), successes are not.
  assert.equal(summary.failures.length, 20);
  assert.equal(summary.results, undefined);

  // Results only when asked, and paged.
  const page = coordinator.getJobStatus('job_fake', { includeResults: true, limit: 20 });
  assert.equal(page.results.length, 20);
  assert.equal(page.nextOffset, 20);
});

test('a job id that aged out points the caller at per-device results', async () => {
  const { coordinator } = createHarness();
  assert.throws(() => coordinator.getJobStatus('job_missing'), /JOB_NOT_FOUND/);
  assert.throws(() => coordinator.getJobStatus('job_missing'), /device_get_task_results/);
});

test('an unknown task policy key is rejected instead of silently dropped', async () => {
  const { coordinator } = createHarness();
  // `commenting` is not a confirmationPolicy key. Stripping it would leave the
  // caller believing it required a confirmation the phone never enforces.
  await assert.rejects(
    () => coordinator.executeTask(
      DEVICE_ID,
      'comment on a post',
      1_000,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { confirmationPolicy: { commenting: 'required' } },
    ),
    /commenting/,
  );
});
