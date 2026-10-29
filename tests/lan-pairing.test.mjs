import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import WebSocket from 'ws';

import {
  DeviceKeyStore,
  PAIRING_REQUIRED_MESSAGE,
  UNCLAIMED_KEY_TTL_MS,
  applyClaim,
  decideAuth,
  hashKey,
  phoneKeyFromRequestUrl,
} from '../dist/device-keys.js';
import {
  PAIR_PATH,
  PAIRING_REQUEST_TTL_MS,
  PairingRequestStore,
  buildPhoneWsUrl,
  handlePairingHttp,
  lanIPv4,
  loadOrCreateDesktopId,
  pickPhoneFacingHost,
} from '../dist/pairing.js';
import { buildTxtRecord } from '../dist/lan-advertiser.js';
import { createPairingRpc } from '../dist/index.js';
import { WsServer, upgradePathname } from '../dist/ws-server.js';

function clock(start = 1_000_000) {
  const c = { now: start, fn: () => c.now };
  return c;
}

// ─── Device keys ─────────────────────────────────────────────────────────────

test('device keys: only the hash is stored, and the file is private', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-keys-'));
  const file = join(dir, 'paired-devices.json');
  const store = new DeviceKeyStore({ file });
  const key = store.mint({ source: 'qr' });
  const raw = readFileSync(file, 'utf8');
  assert.ok(!raw.includes(key), 'plaintext key must not be persisted');
  assert.ok(raw.includes(hashKey(key)));
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('device keys: first use binds the key, another device is refused', () => {
  const c = clock();
  const store = new DeviceKeyStore({ file: null, clock: c.fn });
  const key = store.mint({ source: 'qr' });
  const first = store.authenticate(key, 'phone-A', 'ModelA');
  assert.equal(first.ok, true);
  assert.equal(first.claimedNow, true);
  const again = store.authenticate(key, 'phone-A');
  assert.equal(again.ok, true);
  assert.equal(again.claimedNow, false);
  const other = store.authenticate(key, 'phone-B');
  assert.deepEqual(
    { ok: other.ok, code: other.code, reason: other.reason, message: other.message },
    { ok: false, code: 'PAIRING_REQUIRED', reason: 'device_mismatch', message: PAIRING_REQUIRED_MESSAGE },
  );
  assert.deepEqual(store.listClaimed().map((d) => d.deviceId), ['phone-A']);
});

test('device keys: missing and unknown keys are refused', () => {
  const store = new DeviceKeyStore({ file: null });
  assert.equal(store.authenticate(null, 'p').reason, 'missing_key');
  assert.equal(store.authenticate('', 'p').reason, 'missing_key');
  assert.equal(store.authenticate('nope', 'p').reason, 'unknown_key');
});

test('device keys: unclaimed keys expire, claimed keys do not', () => {
  const c = clock();
  const store = new DeviceKeyStore({ file: null, clock: c.fn });
  const unused = store.mint({ source: 'qr' });
  const used = store.mint({ source: 'qr' });
  assert.equal(store.authenticate(used, 'phone-A').ok, true);
  c.now += UNCLAIMED_KEY_TTL_MS + 1;
  assert.equal(store.authenticate(unused, 'phone-B').reason, 'unknown_key');
  assert.equal(store.authenticate(used, 'phone-A').ok, true);
});

test('device keys: a pre-bound LAN key only works for its device', () => {
  const store = new DeviceKeyStore({ file: null });
  const key = store.mint({ source: 'lan', deviceId: 'phone-A' });
  assert.equal(store.authenticate(key, 'phone-B').reason, 'device_mismatch');
  assert.equal(store.authenticate(key, 'phone-A').ok, true);
});

test('device keys: re-pairing replaces the device\'s previous key', () => {
  const store = new DeviceKeyStore({ file: null });
  const oldKey = store.mint({ source: 'qr' });
  assert.equal(store.authenticate(oldKey, 'phone-A').ok, true);
  const newKey = store.mint({ source: 'lan', deviceId: 'phone-A' });
  assert.equal(store.authenticate(newKey, 'phone-A').ok, true);
  assert.equal(store.authenticate(oldKey, 'phone-A').reason, 'unknown_key');
  assert.equal(store.listClaimed().length, 1);
});

test('device keys: keys survive a restart (file reload)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-keys-'));
  const file = join(dir, 'paired-devices.json');
  const key = new DeviceKeyStore({ file }).mint({ source: 'qr' });
  assert.equal(new DeviceKeyStore({ file }).authenticate(key, 'phone-A').ok, true);
  assert.equal(new DeviceKeyStore({ file }).authenticate(key, 'phone-A').claimedNow, false);
  assert.equal(new DeviceKeyStore({ file }).authenticate(key, 'phone-B').ok, false);
});

test('decideAuth / applyClaim are pure', () => {
  const records = [{ keySha256: hashKey('k'), createdAt: 0, source: 'qr' }];
  const d = decideAuth(records, 'k', 'p', 10);
  assert.equal(d.ok, true);
  const next = applyClaim(records, d.record, 'p', 10);
  assert.equal(records[0].deviceId, undefined);
  assert.equal(next[0].deviceId, 'p');
  assert.equal(next[0].claimedAt, 10);
});

test('phoneKeyFromRequestUrl / upgradePathname', () => {
  assert.equal(phoneKeyFromRequestUrl('/phone?key=abc_-1'), 'abc_-1');
  assert.equal(phoneKeyFromRequestUrl('/phone'), null);
  assert.equal(phoneKeyFromRequestUrl('/phone?key='), null);
  assert.equal(phoneKeyFromRequestUrl(undefined), null);
  assert.equal(upgradePathname('/phone?key=x'), '/phone');
  assert.equal(upgradePathname('/mirror'), '/mirror');
});

// ─── Pairing request store ───────────────────────────────────────────────────

const req = (over = {}) => ({ deviceId: 'M-1', model: 'M', manufacturer: 'Xiaomi', sourceIp: '192.168.1.5', ...over });

test('pairing store: create issues a 6-digit code and a pending request', () => {
  const store = new PairingRequestStore();
  const r = store.create(req());
  assert.equal(r.ok, true);
  assert.match(r.request.code, /^\d{6}$/);
  assert.match(r.request.requestId, /^pr_[0-9a-f]{32}$/);
  assert.equal(store.listPending().length, 1);
  assert.equal('wsUrl' in store.listPending()[0], false);
});

test('pairing store: pending requests expire after the TTL, then disappear', () => {
  const c = clock();
  const store = new PairingRequestStore({ clock: c.fn });
  const { request } = store.create(req());
  c.now += PAIRING_REQUEST_TTL_MS;
  assert.equal(store.get(request.requestId).state, 'expired');
  assert.equal(store.listPending().length, 0);
  assert.equal(store.approve(request.requestId, () => 'ws://x'), undefined);
  c.now += 60_000;
  assert.equal(store.get(request.requestId), undefined);
});

test('pairing store: approve/reject/cancel transitions', () => {
  const store = new PairingRequestStore();
  const a = store.create(req({ deviceId: 'A' })).request;
  const b = store.create(req({ deviceId: 'B' })).request;
  const c = store.create(req({ deviceId: 'C', sourceIp: '192.168.1.6' })).request;
  assert.equal(store.approve(a.requestId, () => 'ws://h:1/phone?key=k').wsUrl, 'ws://h:1/phone?key=k');
  assert.equal(store.approve(a.requestId, () => 'ws://other'), undefined, 'approve is once-only');
  assert.equal(store.reject(b.requestId), true);
  assert.equal(store.get(b.requestId).state, 'rejected');
  assert.equal(store.cancel(c.requestId), true);
  assert.equal(store.get(c.requestId), undefined);
  assert.equal(store.listPending().length, 0);
});

test('pairing store: rate limits per source and globally; a device retry replaces its request', () => {
  const store = new PairingRequestStore();
  for (let i = 0; i < 3; i++) assert.equal(store.create(req({ deviceId: `d${i}` })).ok, true);
  const limited = store.create(req({ deviceId: 'd9' }));
  assert.equal(limited.ok, false);
  assert.equal(limited.status, 429);
  // Same device asking again replaces its own pending request.
  assert.equal(store.create(req({ deviceId: 'd0' })).ok, true);
  assert.equal(store.listPending().length, 3);
  for (let i = 0; i < 7; i++) {
    assert.equal(store.create(req({ deviceId: `x${i}`, sourceIp: `10.0.0.${i}` })).ok, true);
  }
  assert.equal(store.create(req({ deviceId: 'y', sourceIp: '10.0.1.1' })).status, 429);
});

test('pairing store: refuses with 403 when not accepting', () => {
  const store = new PairingRequestStore({ accepting: () => false });
  const r = store.create(req());
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('pairing store: onChange fires for create/approve/cancel/expiry', () => {
  const c = clock();
  let changes = 0;
  const store = new PairingRequestStore({ clock: c.fn, onChange: () => changes++ });
  const a = store.create(req({ deviceId: 'A' })).request;
  store.create(req({ deviceId: 'B' }));
  store.approve(a.requestId, () => 'ws://x');
  c.now += PAIRING_REQUEST_TTL_MS;
  store.sweep();
  assert.equal(changes, 4);
});

// ─── Hosts / URLs / TXT ──────────────────────────────────────────────────────

test('pickPhoneFacingHost prefers the address the phone reached us on', () => {
  assert.equal(pickPhoneFacingHost({ localAddress: '::ffff:192.168.1.20', hostOverride: '10.0.0.2', lanIp: '10.0.0.3' }), '192.168.1.20');
  assert.equal(pickPhoneFacingHost({ localAddress: '127.0.0.1', hostOverride: '10.0.0.2', lanIp: '10.0.0.3' }), '10.0.0.2');
  assert.equal(pickPhoneFacingHost({ localAddress: '::1', hostOverride: '127.0.0.1', lanIp: '10.0.0.3' }), '10.0.0.3');
  assert.equal(pickPhoneFacingHost({ lanIp: null }), '127.0.0.1');
});

test('lanIPv4 skips tunnels and prefers physical interfaces', () => {
  const ifaces = {
    utun3: [{ family: 'IPv4', address: '10.8.0.2', internal: false }],
    bridge100: [{ family: 'IPv4', address: '192.168.64.1', internal: false }],
    lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    en7: [{ family: 'IPv4', address: '169.254.3.3', internal: false }],
    en0: [{ family: 'IPv6', address: 'fe80::1', internal: false }, { family: 'IPv4', address: '192.168.1.20', internal: false }],
  };
  assert.equal(lanIPv4(ifaces), '192.168.1.20');
  assert.equal(lanIPv4({ lo0: ifaces.lo0 }), null);
});

test('buildPhoneWsUrl / TXT record carry no secrets beyond the URL key', () => {
  assert.equal(buildPhoneWsUrl('192.168.1.2', 18790, 'a_b-c'), 'ws://192.168.1.2:18790/phone?key=a_b-c');
  assert.deepEqual(buildTxtRecord({ desktopId: 'tb_1', name: 'n' }), {
    v: '1', kind: 'tabby', name: 'n', id: 'tb_1', pair: PAIR_PATH,
  });
});

test('desktop id is created once and then stable', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'tc-id-')), 'desktop-id.json');
  const id = loadOrCreateDesktopId(file);
  assert.match(id, /^tb_[0-9a-f]{24}$/);
  assert.equal(loadOrCreateDesktopId(file), id);
});

// ─── HTTP endpoints + RPC + WS auth, end to end on loopback ──────────────────

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

function openPhone(url, deviceId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const frames = [];
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: '', deviceId, capabilities: { model: 'M' } })));
    ws.on('message', (data) => {
      frames.push(JSON.parse(data.toString()));
      if (frames[0].type === 'connected') {
        ws.close();
      }
    });
    ws.on('close', (code) => resolve({ code, frames }));
    ws.on('error', reject);
  });
}

test('pairing endpoints → approve → keyed wsUrl → connected; keyless/wrong keys refused', async () => {
  const keys = new DeviceKeyStore({ file: null });
  const store = new PairingRequestStore();
  const ws = new WsServer(0, () => {});
  ws.setVlmCredentialProvider(() => ({ apiUrl: 'https://gw/v1/', apiKey: 'secret', model: 'm' }));
  ws.setDeviceAuthenticator((key, deviceId, model) => {
    const d = keys.authenticate(key, deviceId, model);
    return d.ok ? { ok: true } : d;
  });
  const server = createServer((rq, rs) => {
    if (!handlePairingHttp(rq, rs, store)) {
      rs.writeHead(404);
      rs.end();
    }
  });
  ws.attachToServer(server);
  const port = await listen(server);
  const rpc = createPairingRpc({ store, keys, wsPort: port, enabled: true });
  const base = `http://127.0.0.1:${port}${PAIR_PATH}/requests`;
  try {
    const created = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'M-abc', model: 'M', manufacturer: 'Xiaomi' }),
    });
    assert.equal(created.status, 201);
    const body = await created.json();
    assert.match(body.code, /^\d{6}$/);
    assert.equal(body.expiresInSec, 120);
    assert.equal(body.pollIntervalMs, 1500);

    assert.deepEqual(await (await fetch(`${base}/${body.requestId}`)).json(), { status: 'pending' });
    assert.equal(rpc.list().requests[0].code, body.code);

    assert.equal(rpc.approve(body.requestId, '127.0.0.1'), true);
    const approved = await (await fetch(`${base}/${body.requestId}`)).json();
    assert.equal(approved.status, 'approved');
    // Loopback is never handed to a phone: the host is this machine's LAN IPv4
    // (or 127.0.0.1 only when it has none). Connect over loopback here.
    assert.match(approved.wsUrl, new RegExp(`^ws://[0-9.]+:${port}/phone\\?key=[A-Za-z0-9_-]{43}$`));
    const local = (u) => u.replace(/^ws:\/\/[0-9.]+:/, 'ws://127.0.0.1:');

    assert.equal((await fetch(`${base}/pr_unknown`)).status, 404);

    const good = await openPhone(local(approved.wsUrl), 'M-abc');
    assert.equal(good.frames[0].type, 'connected');
    assert.equal(good.frames[0].vlm.apiKey, 'secret');

    const keyless = await openPhone(`ws://127.0.0.1:${port}/phone`, 'M-abc');
    assert.equal(keyless.code, 4003);
    assert.deepEqual(keyless.frames, [{ type: 'error', code: 'PAIRING_REQUIRED', message: PAIRING_REQUIRED_MESSAGE }]);

    const wrongDevice = await openPhone(local(approved.wsUrl), 'someone-else');
    assert.equal(wrongDevice.code, 4003);
    assert.equal(wrongDevice.frames.some((f) => f.type === 'connected'), false);

    const qr = rpc.createQr('127.0.0.1');
    assert.equal(qr.expiresInSec, 600);
    const viaQr = await openPhone(local(qr.wsUrl), 'other-phone');
    assert.equal(viaQr.frames[0].type, 'connected');

    // DELETE closes the request.
    const second = await (await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'M-2' }),
    })).json();
    assert.equal(rpc.list().requests.length, 1);
    assert.equal((await fetch(`${base}/${second.requestId}`, { method: 'DELETE' })).status, 200);
    assert.equal(rpc.list().requests.length, 0);
    assert.equal(rpc.reject(second.requestId), false);
  } finally {
    ws.stop();
    server.close();
  }
});
