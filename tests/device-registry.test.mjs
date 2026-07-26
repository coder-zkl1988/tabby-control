import assert from 'node:assert/strict';
import test from 'node:test';

import { DeviceRegistry } from '../dist/ws-server.js';
import { createDeviceListTool } from '../dist/tools.js';

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
