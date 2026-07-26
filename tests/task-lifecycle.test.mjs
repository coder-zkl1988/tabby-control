import assert from 'node:assert/strict';
import test from 'node:test';

import { TaskCoordinator } from '../dist/task-coordinator.js';
import {
  createCancelTaskTool,
  createExecuteBatchTool,
  createExecuteTaskTool,
  createGetTaskResultsTool,
} from '../dist/tools.js';

const DEVICE_ID = 'phone-1';

function createHarness() {
  const device = {
    info: {
      deviceId: DEVICE_ID,
      model: 'Test Phone',
      status: 'idle',
      connectedAt: Date.now(),
      lastSeen: Date.now(),
    },
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

test('guidance acknowledgement preserves the paused task identity', async () => {
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
  await originalPromise;

  const resumePromise = coordinator.executeTask(
    DEVICE_ID,
    'task needing input',
    1_000,
    'Use 18500000000',
    originalTaskId,
  );
  const resumeTaskId = executeMessage(sent, 1).params.taskId;
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
  await resumePromise;

  try {
    assert.equal(device.info.status, 'busy');
    assert.equal(device.info.currentTaskId, originalTaskId);
  } finally {
    coordinator.cancelTask(DEVICE_ID, originalTaskId);
  }
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

  for (let index = 0; index < 129; index += 1) {
    const taskPromise = coordinator.executeTask(DEVICE_ID, `task ${index}`, 1_000);
    const observed = taskPromise.catch((error) => error);
    const taskId = executeMessage(sent, index).params.taskId;
    taskIds.push(taskId);
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
