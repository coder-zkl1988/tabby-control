import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import WebSocket from 'ws';

import { DeviceRegistry, WsServer } from '../dist/ws-server.js';
import { TaskCoordinator } from '../dist/task-coordinator.js';
import { createDeviceListTool } from '../dist/tools.js';

class FakePhoneSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  sent = [];
  terminated = false;

  send(payload) {
    this.sent.push(payload);
  }

  ping() {}

  close() {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }

  terminate() {
    this.terminated = true;
    this.close();
  }
}

test('authenticated pong activity keeps public lastSeen fresh while real inactivity still terminates', () => {
  const originalNow = Date.now;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let now = 1_000;
  let heartbeatTick;

  Date.now = () => now;
  globalThis.setInterval = (callback) => {
    heartbeatTick = callback;
    return 1;
  };
  globalThis.clearInterval = () => {};

  try {
    const server = new WsServer(0, () => {});
    const socket = new FakePhoneSocket();
    server.wss.emit('connection', socket, {});
    socket.emit(
      'message',
      Buffer.from(JSON.stringify({ deviceId: 'phone-heartbeat' })),
      false,
    );

    now = 16_000;
    socket.emit('pong');
    assert.equal(server.getRegistry().get('phone-heartbeat').info.lastSeen, now);

    now = 31_000;
    socket.emit('pong');
    assert.equal(server.getRegistry().get('phone-heartbeat').info.lastSeen, now);
    assert.equal(socket.terminated, false);

    now = 61_001;
    heartbeatTick();
    assert.equal(socket.terminated, true);
  } finally {
    Date.now = originalNow;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test('sparse status updates preserve static device capabilities', () => {
  const registry = new DeviceRegistry();
  registry.register('phone-1', {}, {
    model: 'Xiaomi 15',
    osVersion: 35,
    totalRam: 16_000_000_000,
    availableStorage: 128_000_000_000,
  });

  registry.updateStatus('phone-1', {
    skillSyncStatus: 'syncing',
    skillBundleVersion: 1,
  });

  const info = registry.get('phone-1').info;
  assert.equal(info.model, 'Xiaomi 15');
  assert.equal(info.osVersion, 'Android 15');
  assert.equal(info.totalRam, '16.00 GB');
  assert.equal(info.availableStorage, '128.00 GB');
  assert.equal(info.skillSyncStatus, 'syncing');
});

test('explicit undefined still clears transient task identity', () => {
  const registry = new DeviceRegistry();
  registry.register('phone-1', {}, {});
  registry.updateStatus('phone-1', {
    status: 'busy',
    currentTaskId: 'task-1',
  });
  registry.updateStatus('phone-1', {
    status: 'idle',
    currentTaskId: undefined,
  });

  const info = registry.get('phone-1').info;
  assert.equal(info.status, 'idle');
  assert.equal(info.currentTaskId, undefined);
});

test('a stale socket close cannot unregister a replacement connection', () => {
  const registry = new DeviceRegistry();
  const oldSocket = {};
  const replacementSocket = {};

  registry.register('phone-1', oldSocket, {});
  registry.register('phone-1', replacementSocket, {});

  assert.equal(registry.removeImmediately('phone-1', oldSocket), false);
  assert.equal(registry.get('phone-1').ws, replacementSocket);
  assert.equal(registry.removeImmediately('phone-1', replacementSocket), true);
  assert.equal(registry.get('phone-1'), undefined);
});

/** What the phone reports about its installed build, which a reconnect may have replaced. */
const BUILD_STATE_FIELDS = [
  'devicePolicyMode',
  'deviceSkillLayerMode',
  'skillSchemaVersion',
  'skillBundleVersion',
  'skillDigest',
  'skillSyncStatus',
  'skillSyncError',
  'skillLastSyncedAt',
];
/** The device itself and its task, which nothing re-announces on connect. */
const KEPT_ON_RECONNECT_FIELDS = [
  'model',
  'osVersion',
  'totalRam',
  'currentTaskId',
  'currentOperationClass',
  'currentAppRole',
  'activeSkills',
  'skippedSkills',
  'lastPolicyDecision',
  'lastPolicyCode',
  'lastBlockedReason',
];
const pick = (info, fields) => Object.fromEntries(fields.map((field) => [field, info[field]]));

test('a replacement connection forgets the old build state but keeps device and task state', () => {
  const registry = new DeviceRegistry();
  const capabilities = { model: 'Xiaomi 15', osVersion: 35, totalRam: 16_000_000_000 };
  registry.register('phone-1', {}, capabilities);
  registry.updateStatus('phone-1', {
    status: 'busy',
    currentTaskId: 't_running',
    currentOperationClass: 'content.search',
    currentAppRole: 'target_app',
    activeSkills: ['android-core-v1', 'xhs-v18'],
    skippedSkills: ['android-media-picker-v1'],
    deviceSkillLayerMode: 'shadow',
    devicePolicyMode: 'audit',
    lastPolicyDecision: 'block',
    lastPolicyCode: 'POLICY_BROWSER_INSTALL_FORBIDDEN',
    lastBlockedReason: 'browser is not an official store',
    skillSchemaVersion: 2,
    skillBundleVersion: 65,
    skillDigest: 'digest-of-the-old-build',
    skillSyncStatus: 'error',
    skillSyncError: 'SKILL_VALIDATION_FAILED: bad bundle',
    skillLastSyncedAt: 1_000,
  });
  const before = { ...registry.get('phone-1').info };
  for (const field of [...BUILD_STATE_FIELDS, ...KEPT_ON_RECONNECT_FIELDS]) {
    assert.notEqual(before[field], undefined, `${field} must be set before the reconnect`);
  }

  // Same deviceId on a new socket while the old one is still registered.
  registry.register('phone-1', {}, capabilities);

  const info = registry.get('phone-1').info;
  for (const field of BUILD_STATE_FIELDS) {
    assert.equal(info[field], undefined, `${field} must not survive a reconnect`);
  }
  assert.deepEqual(
    pick(info, KEPT_ON_RECONNECT_FIELDS),
    pick(before, KEPT_ON_RECONNECT_FIELDS),
  );
});

test('after a reconnect the policy mode stays unknown until the next TASK_START reports it', async () => {
  const registry = new DeviceRegistry();
  const sent = [];
  const coordinator = new TaskCoordinator(
    {
      getRegistry: () => registry,
      sendToDevice(deviceId, message) {
        sent.push({ deviceId, message });
        return true;
      },
    },
    () => {},
    { resultsFile: join(mkdtempSync(join(tmpdir(), 'tabby-reconnect-')), 'r.json') },
  );
  const policyMode = () => registry.get('phone-1').info.devicePolicyMode;
  const startTask = () => {
    const result = coordinator.executeTask('phone-1', 'open xhs', 1_000);
    const { taskId } = sent.filter(({ message }) => message.method === 'agent.execute')
      .at(-1).message.params;
    return { taskId, result };
  };
  // What PhoneAgentRunner sends before its first step.
  const reportTaskStart = (taskId, mode) => coordinator.handleTaskMessage('phone-1', {
    channel: 'task',
    method: 'agent.progress',
    params: {
      taskId,
      step: 0,
      action: 'TASK_START',
      target: 'com.xingin.xhs',
      progressPercent: 0,
      thinking: '',
      runtime: { operationClass: 'content.search', skillLayerMode: 'enabled', policyMode: mode },
    },
  });
  const finishTask = ({ taskId, result }) => {
    coordinator.handleTaskMessage('phone-1', {
      channel: 'task',
      id: `resp_${taskId}`,
      result: { taskId, success: true, status: 'completed', message: 'done', totalSteps: 1 },
    });
    return result;
  };

  registry.register('phone-1', {}, {});
  const auditTask = startTask();
  reportTaskStart(auditTask.taskId, 'audit');
  assert.equal(policyMode(), 'audit');
  await finishTask(auditTask);
  assert.equal(policyMode(), 'audit');

  // An enforce-mode APK replaced the audit one; the old socket is still registered.
  registry.register('phone-1', {}, {});
  assert.equal(policyMode(), undefined);

  const enforceTask = startTask();
  assert.equal(policyMode(), undefined);
  reportTaskStart(enforceTask.taskId, 'enforce');
  assert.equal(policyMode(), 'enforce');
  assert.equal(registry.get('phone-1').info.deviceSkillLayerMode, 'enabled');
  await finishTask(enforceTask);
});

test('device_list surfaces skill sync status and errors to the desktop agent', async () => {
  const tool = createDeviceListTool({
    async listDevices() {
      return [{
        deviceId: 'phone-1',
        model: 'Xiaomi 15',
        status: 'idle',
        connectedAt: Date.now(),
        lastSeen: Date.now(),
        skillBundleVersion: 1,
        skillSyncStatus: 'error',
        skillSyncError: 'SKILL_VALIDATION_FAILED: bad bundle',
      }];
    },
  });

  const result = await tool.execute();
  assert.match(result.content[0].text, /skills=error@1/);
  assert.match(result.content[0].text, /SKILL_VALIDATION_FAILED/);
});

test('device_list surfaces layered runtime and the last policy block', async () => {
  const tool = createDeviceListTool({
    async listDevices() {
      return [{
        deviceId: 'phone-1',
        model: 'Xiaomi 15',
        status: 'idle',
        connectedAt: Date.now(),
        lastSeen: Date.now(),
        deviceSkillLayerMode: 'enabled',
        devicePolicyMode: 'audit',
        currentOperationClass: 'content.publish',
        currentAppRole: 'target_app',
        activeSkills: ['android-core-v1', 'android-text-input-v1', 'xhs-v1/post'],
        lastBlockedReason: 'browser is not an official store',
      }];
    },
  });

  const result = await tool.execute();
  assert.match(result.content[0].text, /runtime=enabled\/audit/);
  assert.match(result.content[0].text, /operation=content\.publish/);
  assert.match(result.content[0].text, /role=target_app/);
  assert.match(result.content[0].text, /activeSkills=android-core-v1,android-text-input-v1,xhs-v1\/post/);
  assert.match(result.content[0].text, /lastBlocked=browser is not an official store/);
});
