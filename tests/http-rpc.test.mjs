import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { startHttpServer } from '../dist/index.js';

test('HTTP execute_task forwards resume and task policy parameters', async (t) => {
  const calls = [];
  const coordinator = {
    async executeTask(...args) {
      calls.push(args);
      return {
        taskId: 'resume-ack',
        success: true,
        message: 'Guidance received',
      };
    },
  };
  const bridge = {
    async listDevices() {
      return [];
    },
  };
  const logger = {
    info() {},
  };
  const server = startHttpServer(
    0,
    coordinator,
    bridge,
    () => {},
    logger,
    () => {},
    () => {},
  );
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, 'listening');

  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');

  const response = await fetch(`http://127.0.0.1:${address.port}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      method: 'device_execute_task',
      params: {
        deviceId: 'phone-1',
        task: 'resume task',
        timeoutMs: 1_234,
        guidance: 'Use 42',
        sessionId: 'original-task',
        maxSteps: 7,
        allowedActions: ['Tap'],
        allowedApps: ['com.xingin.xhs'],
        taskPolicy: {
          operationClass: 'account.login',
          targetPackages: ['com.xingin.xhs'],
          allowedAppRoles: ['target_app', 'default_sms'],
          confirmationPolicy: {
            login: 'required',
            payment: 'forbidden',
          },
        },
      },
    }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    result: {
      taskId: 'resume-ack',
      success: true,
      message: 'Guidance received',
    },
  });
  assert.deepEqual(calls, [[
    'phone-1',
    'resume task',
    1_234,
    'Use 42',
    'original-task',
    7,
    ['Tap'],
    ['com.xingin.xhs'],
    {
      operationClass: 'account.login',
      targetPackages: ['com.xingin.xhs'],
      allowedAppRoles: ['target_app', 'default_sms'],
      confirmationPolicy: {
        login: 'required',
        payment: 'forbidden',
      },
    },
  ]]);
});

test('HTTP execute_task reports cancellation with a stable error code', async (t) => {
  const coordinator = {
    async executeTask() {
      throw new Error('CANCELLED');
    },
  };
  const bridge = {
    async listDevices() {
      return [];
    },
  };
  const logger = {
    info() {},
  };
  const server = startHttpServer(
    0,
    coordinator,
    bridge,
    () => {},
    logger,
    () => {},
    () => {},
  );
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, 'listening');

  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');

  const response = await fetch(`http://127.0.0.1:${address.port}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      method: 'device_execute_task',
      params: {
        deviceId: 'phone-1',
        task: 'cancelled task',
      },
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    error: {
      code: 'CANCELLED',
      message: 'CANCELLED',
    },
  });
});
