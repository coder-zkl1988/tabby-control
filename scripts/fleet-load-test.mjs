/**
 * Fleet load test — synthetic phones against a running tabby-control.
 *
 * A phone is a WebSocket client, so a fleet does not need real hardware to
 * exercise the paths that break at scale: the device registry, fan-out
 * dispatch, per-device result retention, and the change-broadcast that fires on
 * every progress frame.
 *
 * Usage (tabby-control must already be running — e.g. `pnpm dev start openclaw`):
 *
 *   node scripts/fleet-load-test.mjs --devices 300
 *   node scripts/fleet-load-test.mjs --devices 50 --stuck 5 --ws-port 18790
 *
 * Options:
 *   --devices N      synthetic phones to connect (default 50)
 *   --stuck N        of those, N never answer a task (default 2)
 *   --min-task-ms    fastest simulated task (default 20000)
 *   --max-task-ms    slowest simulated task (default 240000)
 *   --progress-ms    heartbeat interval per phone (default 15000)
 *   --ws-port        phone WebSocket port (default 18790)
 *   --rpc-port       control RPC port (default 18801)
 *   --skip-dispatch  connect and idle only, to measure connection cost alone
 */

import WebSocket from 'ws';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] != null ? Number(argv[i + 1]) : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const DEVICES = arg('devices', 50);
const STUCK = Math.min(arg('stuck', 2), DEVICES);
const MIN_TASK_MS = arg('min-task-ms', 20_000);
const MAX_TASK_MS = arg('max-task-ms', 240_000);
const PROGRESS_MS = arg('progress-ms', 15_000);
const WS_PORT = arg('ws-port', 18790);
const RPC_PORT = arg('rpc-port', 18801);
const SKIP_DISPATCH = flag('skip-dispatch');

const PREFIX = `loadtest-${Date.now().toString(36)}`;

/** Mirrors what a real build reports, so the vocabulary path is exercised too. */
const SUPPORTED_ACTIONS = [
  'CLICK', 'DOUBLE_CLICK', 'LONGPRESS', 'TYPE', 'SLIDE', 'SCROLL', 'BACK',
  'ENTER', 'HOME', 'AWAKE', 'WAIT', 'LONGPRESSANDDRAG', 'ZOOM', 'ZOOMINOUT',
  'CAPTURE_ARTIFACT', 'INFO', 'CALL_USER', 'COMPLETE', 'ABORT',
];
const ACTION_ALIASES = {
  TAP: 'CLICK', SWIPE: 'SLIDE', LAUNCH: 'AWAKE', STARTAPP: 'AWAKE',
  INPUTTEXT: 'TYPE', TEXT: 'TYPE', PRESSBACK: 'BACK', PRESSHOME: 'HOME',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;

async function rpc(method, params) {
  const res = await fetch(`http://127.0.0.1:${RPC_PORT}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body.result;
}

class SyntheticPhone {
  constructor(index, { stuck }) {
    this.deviceId = `${PREFIX}-${String(index).padStart(4, '0')}`;
    this.stuck = stuck;
    this.ws = null;
    this.connectMs = 0;
    this.tasksReceived = 0;
    this.tasksAnswered = 0;
    this.currentTaskId = null;
    this.heartbeat = null;
  }

  connect() {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}/phone`);
      this.ws = ws;
      const failFast = (err) => reject(err instanceof Error ? err : new Error(String(err)));

      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'auth',
          token: '',
          deviceId: this.deviceId,
          capabilities: {
            model: 'LoadTest', manufacturer: 'Synthetic', osVersion: 35,
            screenWidth: 1080, screenHeight: 2400, currentApp: 'com.lobster.agent',
            batteryLevel: 100, isCharging: true, isWifiConnected: true,
            supportedActions: SUPPORTED_ACTIONS, actionAliases: ACTION_ALIASES,
          },
        }));
      });

      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type === 'connected') {
          this.connectMs = Date.now() - started;
          this.startHeartbeat();
          resolve(this);
          return;
        }
        if (msg.type === 'error') { failFast(new Error(msg.message ?? 'auth error')); return; }
        if (msg.channel === 'task' && msg.method === 'agent.execute') this.onTask(msg);
      });

      ws.on('error', failFast);
      ws.on('close', () => { if (this.heartbeat) clearInterval(this.heartbeat); });
    });
  }

  startHeartbeat() {
    // Only meaningful while a task is running — that is when the real app reports.
    this.heartbeat = setInterval(() => {
      if (!this.currentTaskId || this.ws?.readyState !== WebSocket.OPEN) return;
      this.send({ channel: 'task', method: 'agent.progress', params: { taskId: this.currentTaskId, step: 1 } });
    }, PROGRESS_MS);
  }

  send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  onTask(msg) {
    const taskId = msg.params?.taskId ?? msg.id;
    this.tasksReceived += 1;
    this.currentTaskId = taskId;
    // A stuck phone keeps sending progress but never returns a result — the
    // case that makes a blocking fan-out hold the caller open indefinitely.
    if (this.stuck) return;

    const duration = MIN_TASK_MS + Math.random() * (MAX_TASK_MS - MIN_TASK_MS);
    setTimeout(() => {
      this.send({
        channel: 'task',
        id: `resp_${taskId}`,
        result: {
          taskId,
          success: true,
          status: 'completed',
          message: `synthetic result from ${this.deviceId}`,
          totalSteps: 12,
          duration: Math.round(duration),
        },
      });
      this.tasksAnswered += 1;
      this.currentTaskId = null;
    }, duration);
  }

  close() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.ws?.close();
  }
}

function sampleProcess() {
  const m = process.memoryUsage();
  return { rssMb: +(m.rss / 1048576).toFixed(1), heapMb: +(m.heapUsed / 1048576).toFixed(1) };
}

async function main() {
  console.log(`\n=== Fleet load test: ${DEVICES} phones (${STUCK} stuck) ===`);
  console.log(`ws=127.0.0.1:${WS_PORT}  rpc=127.0.0.1:${RPC_PORT}  task ${MIN_TASK_MS}-${MAX_TASK_MS}ms\n`);

  // ── Phase 1: connect ────────────────────────────────────────────────────────
  const phones = Array.from({ length: DEVICES }, (_, i) => new SyntheticPhone(i, { stuck: i < STUCK }));
  const connectStart = Date.now();
  const settled = await Promise.allSettled(phones.map((p) => p.connect()));
  const connected = settled.filter((s) => s.status === 'fulfilled').length;
  const failed = settled.filter((s) => s.status === 'rejected');
  const connectTotal = Date.now() - connectStart;

  const connectTimes = phones.filter((p) => p.connectMs).map((p) => p.connectMs).sort((a, b) => a - b);
  console.log(`[connect] ${connected}/${DEVICES} in ${connectTotal}ms`);
  console.log(`[connect] per-phone p50=${pct(connectTimes, 0.5)}ms p95=${pct(connectTimes, 0.95)}ms max=${connectTimes.at(-1) ?? 0}ms`);
  if (failed.length) console.log(`[connect] ❌ ${failed.length} failed, first: ${failed[0].reason?.message}`);

  await sleep(2000);
  const listStart = Date.now();
  const listed = await rpc('device_list', {});
  const mine = (listed?.devices ?? listed ?? []).filter?.((d) => d.deviceId?.startsWith(PREFIX)) ?? [];
  console.log(`[registry] device_list returned ${mine.length} of ours in ${Date.now() - listStart}ms`);

  if (SKIP_DISPATCH) {
    console.log('\n--skip-dispatch: holding connections for 60s to observe idle cost…');
    await sleep(60_000);
    phones.forEach((p) => p.close());
    return;
  }

  // ── Phase 2: dispatch ───────────────────────────────────────────────────────
  const tasks = phones.map((p) => ({ deviceId: p.deviceId, task: 'synthetic fleet sweep' }));
  const dispatchStart = Date.now();
  const { jobId, deviceCount } = await rpc('device_dispatch_tasks', { tasks, timeoutMs: MAX_TASK_MS + 120_000 });
  const dispatchMs = Date.now() - dispatchStart;
  console.log(`\n[dispatch] ${deviceCount} devices in ${dispatchMs}ms  jobId=${jobId}`);
  console.log(`[dispatch] ${dispatchMs < 1000 ? '✅ constant-time' : '⚠️  slow — dispatch should not scale with fleet size'}`);

  // ── Phase 3: poll ───────────────────────────────────────────────────────────
  const pollTimes = [];
  let status;
  const expectedDone = DEVICES - STUCK;
  const deadline = Date.now() + MAX_TASK_MS + 180_000;
  while (Date.now() < deadline) {
    const t = Date.now();
    status = await rpc('device_job_status', { jobId });
    pollTimes.push(Date.now() - t);
    const mem = sampleProcess();
    process.stdout.write(
      `\r[poll] running=${status.running} ok=${status.succeeded} fail=${status.failed} `
      + `| status ${Date.now() - t}ms | harness rss=${mem.rssMb}MB   `,
    );
    if (status.succeeded >= expectedDone) break;
    await sleep(5000);
  }
  console.log('');

  const sorted = pollTimes.sort((a, b) => a - b);
  console.log(`[poll] device_job_status p50=${pct(sorted, 0.5)}ms p95=${pct(sorted, 0.95)}ms max=${sorted.at(-1)}ms`);
  console.log(`[poll] ${pct(sorted, 0.95) < 500 ? '✅ status stays cheap' : '⚠️  status cost grows with fleet size'}`);

  // ── Phase 4: the invariant that matters — no result silently evicted ────────
  const answered = phones.filter((p) => !p.stuck);
  let recovered = 0;
  const missing = [];
  for (const p of answered) {
    const results = await rpc('device_get_task_results', { deviceId: p.deviceId, limit: 1 });
    if (Array.isArray(results) && results.length) recovered += 1;
    else missing.push(p.deviceId);
  }
  console.log(`\n[retention] ${recovered}/${answered.length} devices can still retrieve their own result`);
  if (missing.length) {
    console.log(`[retention] ❌ ${missing.length} evicted before collection, e.g. ${missing.slice(0, 5).join(', ')}`);
  } else {
    console.log('[retention] ✅ no device lost its result to another device finishing later');
  }

  console.log(`\n[stuck] ${STUCK} phone(s) never answered; job reports running=${status?.running ?? '?'} `
    + `— ${status && status.succeeded >= expectedDone ? '✅ the rest were unaffected' : '⚠️  check for cross-device blocking'}`);

  await rpc('device_cancel_job', { jobId }).catch(() => {});
  phones.forEach((p) => p.close());
  console.log('\nDone. Connections closed.\n');
}

main().catch((err) => {
  console.error(`\nLoad test failed: ${err.message}`);
  process.exit(1);
});
