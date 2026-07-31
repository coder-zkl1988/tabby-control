import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';

import { BridgeClient } from '../dist/bridge.js';
import { startHttpServer } from '../dist/index.js';

const silentLogger = { info() {}, warn() {}, error() {} };

/** Minimal /rpc stub that only answers after `delayMs`. */
function startSlowRpcServer(delayMs) {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      setTimeout(() => {
        if (res.writableEnded) return;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: { ok: true } }));
      }, delayMs);
    });
  });
  server.listen(0, '127.0.0.1');
  return server;
}

function addressPort(server) {
  const address = server.address();
  assert.equal(typeof address, 'object');
  return address.port;
}

test('agent-loop RPCs outlive the transport deadline that still guards control-plane RPCs', async (t) => {
  const server = startSlowRpcServer(400);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, 'listening');

  // A 150ms transport deadline — far shorter than the server's 400ms answer.
  const client = new BridgeClient(addressPort(server), 150);

  // Control plane: a hung server must still fail fast.
  await assert.rejects(() => client.listDevices(), /abort/i);

  // Agent loop: the coordinator owns the deadline (its timer is idle-based and
  // re-armed by every heartbeat), so the transport must not cut this off.
  assert.deepEqual(
    await client.executeBatch([{ deviceId: 'phone-1', task: 'browse 10 posts' }], 60_000),
    { ok: true },
  );
  assert.deepEqual(await client.executeTask('phone-1', 'browse 10 posts', 60_000), { ok: true });
  assert.deepEqual(await client.executeTaskAll('browse 10 posts', 60_000), { ok: true });
});

test('a client that disconnects mid-batch does not cancel phone tasks', async (t) => {
  const cancelled = [];
  const warnings = [];
  let releaseBatch;
  const coordinator = {
    // Stay pending until after the HTTP caller disconnects, like a phone that
    // is still stepping through a long publish flow.
    executeBatch: () => new Promise((resolve) => { releaseBatch = resolve; }),
    cancelTask(deviceId, taskId) {
      cancelled.push({ deviceId, taskId });
    },
  };
  const server = startHttpServer(
    0,
    coordinator,
    { async listDevices() { return []; } },
    () => {},
    { ...silentLogger, warn(message) { warnings.push(message); } },
    () => {},
    () => {},
  );
  t.after(() => {
    releaseBatch?.(new Map());
    return new Promise((resolve) => server.close(resolve));
  });
  await once(server, 'listening');

  const controller = new AbortController();
  const pending = fetch(`http://127.0.0.1:${addressPort(server)}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      method: 'device_execute_batch',
      params: {
        tasks: [
          { deviceId: 'phone-1', task: '搜索羽毛球' },
          { deviceId: 'phone-2', task: '搜索足球' },
        ],
      },
    }),
    signal: controller.signal,
  });
  const observed = pending.catch((error) => error);

  await new Promise((resolve) => setTimeout(resolve, 50));
  controller.abort();
  assert.match(String(await observed), /abort/i);
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(cancelled, []);

  releaseBatch(new Map([
    ['phone-1', { taskId: 't_1', success: true, message: 'done' }],
    ['phone-2', { taskId: 't_2', success: true, message: 'done' }],
  ]));
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(cancelled, []);
  assert.ok(warnings.some((message) => message.includes('available for recovery')));
});

test('a completed request does not cancel the devices it dispatched', async (t) => {
  const cancelled = [];
  const coordinator = {
    async executeBatch() {
      return { 'phone-1': { taskId: 't_1', success: true, message: 'done' } };
    },
    cancelTask(deviceId, taskId) {
      cancelled.push({ deviceId, taskId });
    },
  };
  const server = startHttpServer(
    0,
    coordinator,
    { async listDevices() { return []; } },
    () => {},
    silentLogger,
    () => {},
    () => {},
  );
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, 'listening');

  const response = await fetch(`http://127.0.0.1:${addressPort(server)}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      method: 'device_execute_batch',
      params: { tasks: [{ deviceId: 'phone-1', task: '搜索羽毛球' }] },
    }),
  });
  assert.equal(response.status, 200);
  await response.json();
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(cancelled, []);
});
