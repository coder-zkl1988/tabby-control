#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { parseArgs } from 'node:util';
import { promisify } from 'node:util';

import { requestJson } from './http-json-client.mjs';
import { checkExpectedResult } from './release-gate-result-checks.mjs';
import { resolveTaskRequestTimeoutMs } from './release-gate-timeouts.mjs';

const DEFAULT_RPC_URL = 'http://127.0.0.1:18801';
const DEFAULT_REPORT_DIR = path.join(homedir(), '.tabby', 'release-gates');
const POLL_INTERVAL_MS = 100;
const execFileAsync = promisify(execFile);

function fail(message) {
  throw new Error(`[release-gate] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index];
}

function sanitizeFileName(value) {
  return value.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-').slice(0, 80);
}

function isoFileTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function xmlAttribute(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function resolveAdbPath(config) {
  if (config?.path) return config.path;
  if (process.env.ADB) return process.env.ADB;
  const sdkRoot = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  return sdkRoot ? path.join(sdkRoot, 'platform-tools', 'adb') : 'adb';
}

async function adbCommand(adbConfig, deviceId, args, timeoutMs = 15_000) {
  const serial = adbConfig?.serialByDeviceId?.[deviceId];
  if (!serial) fail(`ADB 配置缺少设备 ${deviceId} 的 serial`);
  const { stdout, stderr } = await execFileAsync(
    resolveAdbPath(adbConfig),
    ['-s', serial, ...args],
    { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
  );
  return `${stdout}${stderr}`;
}

async function prepareDevice(scenario, deviceId) {
  for (const packageName of scenario.adb?.preTaskForceStopPackages ?? []) {
    await adbCommand(scenario.adb, deviceId, [
      'shell',
      'am',
      'force-stop',
      packageName,
    ]);
  }
  const packageName = scenario.adb?.preTaskLaunchPackage;
  if (!packageName) return null;
  await adbCommand(scenario.adb, deviceId, [
    'shell',
    'monkey',
    '-p',
    packageName,
    '-c',
    'android.intent.category.LAUNCHER',
    '1',
  ]);
  await sleep(scenario.adb.preTaskSettleMs ?? 500);
  return packageName;
}

async function probeDevice(scenario, deviceId) {
  const assertions = scenario.adb?.assertions;
  if (!assertions) return null;
  const failures = [];
  const activity = await adbCommand(
    scenario.adb,
    deviceId,
    ['shell', 'dumpsys', 'activity', 'activities'],
  );
  const topActivity = activity.match(
    /topResumedActivity=.*? u\d+ ([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)/,
  )?.[1] ?? activity.match(
    /ResumedActivity:.*? u\d+ ([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)/,
  )?.[1] ?? null;
  const foregroundPackage = topActivity?.split('/', 1)[0] ?? null;
  if (
    assertions.foregroundPackage &&
    foregroundPackage !== assertions.foregroundPackage
  ) {
    failures.push(
      `foregroundPackage expected=${assertions.foregroundPackage} actual=${foregroundPackage}`,
    );
  }
  for (const expected of assertions.activityContains ?? []) {
    if (!activity.includes(expected)) {
      failures.push(`activityContains missing=${JSON.stringify(expected)}`);
    }
  }
  for (const expected of assertions.topActivityContains ?? []) {
    if (!topActivity?.includes(expected)) {
      failures.push(
        `topActivityContains missing=${JSON.stringify(expected)} actual=${JSON.stringify(topActivity)}`,
      );
    }
  }

  let uiXml = '';
  if (assertions.uiTextEquals?.length || assertions.uiContains?.length) {
    uiXml = await adbCommand(
      scenario.adb,
      deviceId,
      ['exec-out', 'uiautomator', 'dump', '/dev/tty'],
      scenario.adb.uiDumpTimeoutMs ?? 20_000,
    );
  }
  for (const expected of assertions.uiTextEquals ?? []) {
    if (!uiXml.includes(`text="${xmlAttribute(expected)}"`)) {
      failures.push(`uiTextEquals missing=${JSON.stringify(expected)}`);
    }
  }
  for (const expected of assertions.uiContains ?? []) {
    if (!uiXml.includes(expected)) {
      failures.push(`uiContains missing=${JSON.stringify(expected)}`);
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    foregroundPackage,
    topActivity,
    activityBytes: Buffer.byteLength(activity),
    uiXmlBytes: Buffer.byteLength(uiXml),
  };
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    fail(`无法读取配置 ${filePath}: ${String(error)}`);
  }
}

async function rpc(rpcUrl, method, params, timeoutMs) {
  return requestJson(
    `${rpcUrl}/rpc`,
    {
      method: 'POST',
      body: JSON.stringify({ method, params }),
    },
    timeoutMs,
  );
}

async function listDevices(rpcUrl) {
  const body = await requestJson(`${rpcUrl}/devices`);
  if (!Array.isArray(body.devices)) fail('/devices 响应缺少 devices 数组');
  return body.devices;
}

function checkExpectedDevice(device, expected = {}) {
  const mismatches = [];
  for (const [field, value] of Object.entries(expected)) {
    if (device[field] !== value) {
      mismatches.push(`${field}: expected=${JSON.stringify(value)} actual=${JSON.stringify(device[field])}`);
    }
  }
  return mismatches;
}

async function waitForDevice(rpcUrl, deviceId, predicate, timeoutMs) {
  const startedAt = Date.now();
  let lastDevice = null;
  while (Date.now() - startedAt <= timeoutMs) {
    const devices = await listDevices(rpcUrl);
    lastDevice = devices.find((device) => device.deviceId === deviceId) ?? null;
    if (lastDevice && predicate(lastDevice)) {
      return { device: lastDevice, elapsedMs: Date.now() - startedAt };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { device: lastDevice, elapsedMs: Date.now() - startedAt };
}

async function waitForTaskTerminal(rpcUrl, deviceId, taskId, timeoutMs) {
  const startedAt = Date.now();
  let lastEntry = null;
  while (Date.now() - startedAt <= timeoutMs) {
    const response = await rpc(
      rpcUrl,
      'device_get_task_results',
      { deviceId, taskId, limit: 1 },
      Math.min(timeoutMs, 10_000),
    );
    lastEntry = response?.result?.find((entry) => entry.taskId === taskId) ?? null;
    if (lastEntry && ['aborted', 'cancelled', 'error'].includes(lastEntry.result?.status)) {
      return { entry: lastEntry, elapsedMs: Date.now() - startedAt };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { entry: lastEntry, elapsedMs: Date.now() - startedAt };
}

async function observeUntilSettled(rpcUrl, deviceId, promise, intervalMs = 250) {
  const observedApps = new Set();
  const policyDecisions = [];
  let settled = false;
  let value;
  let rejection;

  promise.then(
    (result) => {
      settled = true;
      value = result;
    },
    (error) => {
      settled = true;
      rejection = error;
    },
  );

  while (!settled) {
    try {
      const device = (await listDevices(rpcUrl)).find((item) => item.deviceId === deviceId);
      if (device?.currentApp) observedApps.add(device.currentApp);
      if (device?.lastPolicyDecision || device?.lastPolicyCode) {
        const decision = {
          decision: device.lastPolicyDecision ?? null,
          code: device.lastPolicyCode ?? null,
          reason: device.lastPolicyReason ?? null,
          app: device.currentApp ?? null,
        };
        if (JSON.stringify(policyDecisions.at(-1)) !== JSON.stringify(decision)) {
          policyDecisions.push(decision);
        }
      }
    } catch {
      // The task response remains authoritative; transient sampling failures are recorded later.
    }
    await sleep(intervalMs);
  }

  if (rejection) throw rejection;
  return { value, observedApps: [...observedApps], policyDecisions };
}

function forbiddenApps(observedApps, forbiddenPrefixes) {
  return observedApps.filter((app) => forbiddenPrefixes.some((prefix) => app === prefix || app.startsWith(prefix)));
}

async function runTaskIteration({ rpcUrl, scenario, deviceId, iteration }) {
  await prepareDevice(scenario, deviceId);
  const startedAt = Date.now();
  const executePromise = rpc(
    rpcUrl,
    'device_execute_task',
    { deviceId, ...scenario.task },
    resolveTaskRequestTimeoutMs(scenario),
  );
  const observation = await observeUntilSettled(
    rpcUrl,
    deviceId,
    executePromise,
    scenario.sampleIntervalMs ?? 250,
  );
  const responseAt = Date.now();
  const idle = await waitForDevice(
    rpcUrl,
    deviceId,
    (device) => device.status === 'idle',
    scenario.idleTimeoutMs ?? 5_000,
  );
  const response = observation.value;
  const result = response?.result;
  const forbidden = forbiddenApps(
    observation.observedApps,
    scenario.forbiddenAppPrefixes ?? [],
  );
  const runtimeMismatches = checkExpectedDevice(idle.device ?? {}, scenario.expectedRuntime);
  const resultMismatches = checkExpectedResult(result, scenario.expectedResult);
  const deviceProbe = await probeDevice(scenario, deviceId);
  const passed = resultMismatches.length === 0 &&
    idle.device?.status === 'idle' &&
    forbidden.length === 0 &&
    runtimeMismatches.length === 0 &&
    deviceProbe?.passed !== false;

  return {
    iteration,
    deviceId,
    kind: 'task',
    startedAt: new Date(startedAt).toISOString(),
    durationMs: responseAt - startedAt,
    idleConvergenceMs: idle.elapsedMs,
    passed,
    taskId: result?.taskId ?? null,
    result: result ?? null,
    rpcError: response?.error ?? null,
    observedApps: observation.observedApps,
    forbiddenApps: forbidden,
    runtimeMismatches,
    resultMismatches,
    deviceProbe,
    policyDecisions: observation.policyDecisions,
    finalDevice: idle.device,
  };
}

async function runCancelIteration({ rpcUrl, scenario, deviceId, iteration }) {
  const startedAt = Date.now();
  const executePromise = rpc(
    rpcUrl,
    'device_execute_task',
    { deviceId, ...scenario.task },
    scenario.requestTimeoutMs ?? 120_000,
  );
  const busy = await waitForDevice(
    rpcUrl,
    deviceId,
    (device) => device.status === 'busy' && Boolean(device.currentTaskId),
    scenario.busyTimeoutMs ?? 5_000,
  );
  const taskId = busy.device?.currentTaskId ?? null;

  if (!taskId) {
    const response = await executePromise;
    return {
      iteration,
      deviceId,
      kind: 'cancel',
      startedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      idleConvergenceMs: null,
      passed: false,
      taskId: null,
      result: response?.result ?? null,
      rpcError: response?.error ?? { code: 'BUSY_NOT_OBSERVED', message: '未观察到 busy/currentTaskId' },
      observedApps: [],
      forbiddenApps: [],
      policyDecisions: [],
      finalDevice: busy.device,
    };
  }

  await sleep(scenario.cancelDelayMs ?? 250);
  const cancelStartedAt = Date.now();
  const cancelResponse = await rpc(
    rpcUrl,
    'device_cancel_task',
    { deviceId, taskId },
    scenario.cancelTimeoutMs ?? 10_000,
  );
  if (cancelResponse?.result?.cancelled !== true) {
    fail(`设备 ${deviceId} 取消 ${taskId} 失败: ${JSON.stringify(cancelResponse)}`);
  }
  const taskResponse = await executePromise;
  const terminal = await waitForTaskTerminal(
    rpcUrl,
    deviceId,
    taskId,
    scenario.phoneTerminalTimeoutMs ?? 5_000,
  );
  const cancellationLatencyMs = Date.now() - cancelStartedAt;
  const idle = await waitForDevice(
    rpcUrl,
    deviceId,
    (device) => device.status === 'idle',
    scenario.idleTimeoutMs ?? 5_000,
  );
  const passed = cancelResponse?.result?.cancelled === true &&
    taskResponse?.error?.code === 'CANCELLED' &&
    ['aborted', 'cancelled'].includes(terminal.entry?.result?.status) &&
    idle.device?.status === 'idle';

  return {
    iteration,
    deviceId,
    kind: 'cancel',
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    cancellationLatencyMs,
    idleConvergenceMs: idle.elapsedMs,
    passed,
    taskId,
    result: taskResponse?.result ?? null,
    rpcError: taskResponse?.error ?? null,
    cancelResponse,
    phoneTerminalResult: terminal.entry,
    observedApps: [busy.device?.currentApp].filter(Boolean),
    forbiddenApps: [],
    runtimeMismatches: [],
    policyDecisions: [],
    finalDevice: idle.device,
  };
}

async function runCancelRestartIteration({ rpcUrl, scenario, deviceId, iteration }) {
  const startedAt = Date.now();
  const originalExecutePromise = rpc(
    rpcUrl,
    'device_execute_task',
    { deviceId, ...scenario.task },
    scenario.requestTimeoutMs ?? 120_000,
  );
  const originalBusy = await waitForDevice(
    rpcUrl,
    deviceId,
    (device) => device.status === 'busy' && Boolean(device.currentTaskId),
    scenario.busyTimeoutMs ?? 5_000,
  );
  const originalTaskId = originalBusy.device?.currentTaskId ?? null;

  if (!originalTaskId) {
    const response = await originalExecutePromise;
    return {
      iteration,
      deviceId,
      kind: 'cancel-restart',
      startedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      idleConvergenceMs: null,
      restartAcceptanceMs: null,
      passed: false,
      taskId: null,
      restartTaskId: null,
      result: response?.result ?? null,
      rpcError: response?.error ?? { code: 'BUSY_NOT_OBSERVED', message: '未观察到旧任务 busy/currentTaskId' },
      observedApps: [],
      forbiddenApps: [],
      policyDecisions: [],
      finalDevice: originalBusy.device,
    };
  }

  await sleep(scenario.cancelDelayMs ?? 250);
  const originalCancelStartedAt = Date.now();
  const originalCancelResponse = await rpc(
    rpcUrl,
    'device_cancel_task',
    { deviceId, taskId: originalTaskId },
    scenario.cancelTimeoutMs ?? 10_000,
  );

  const restartStartedAt = Date.now();
  const restartExecutePromise = rpc(
    rpcUrl,
    'device_execute_task',
    { deviceId, ...(scenario.restartTask ?? scenario.task) },
    scenario.requestTimeoutMs ?? 120_000,
  );
  const restartBusy = await waitForDevice(
    rpcUrl,
    deviceId,
    (device) =>
      device.status === 'busy' &&
      Boolean(device.currentTaskId) &&
      device.currentTaskId !== originalTaskId,
    scenario.restartBusyTimeoutMs ?? 5_000,
  );
  const restartTaskId = restartBusy.device?.currentTaskId ?? null;
  const restartAcceptanceMs = restartTaskId ? Date.now() - restartStartedAt : null;

  let restartCancelStartedAt = null;
  let restartCancelResponse = null;
  if (restartTaskId) {
    await sleep(scenario.restartCancelDelayMs ?? 250);
    restartCancelStartedAt = Date.now();
    restartCancelResponse = await rpc(
      rpcUrl,
      'device_cancel_task',
      { deviceId, taskId: restartTaskId },
      scenario.cancelTimeoutMs ?? 10_000,
    );
  }

  const originalTaskResponse = await originalExecutePromise;
  const restartTaskResponse = await restartExecutePromise;
  const originalTerminal = await waitForTaskTerminal(
    rpcUrl,
    deviceId,
    originalTaskId,
    scenario.phoneTerminalTimeoutMs ?? 5_000,
  );
  const originalCancellationLatencyMs = Date.now() - originalCancelStartedAt;
  const restartTerminal = restartTaskId
    ? await waitForTaskTerminal(
      rpcUrl,
      deviceId,
      restartTaskId,
      scenario.phoneTerminalTimeoutMs ?? 5_000,
    )
    : { entry: null, elapsedMs: null };
  const restartCancellationLatencyMs = restartCancelStartedAt == null
    ? null
    : Date.now() - restartCancelStartedAt;
  const cancellationLatencyMs = restartCancellationLatencyMs == null
    ? originalCancellationLatencyMs
    : Math.max(originalCancellationLatencyMs, restartCancellationLatencyMs);
  const idle = await waitForDevice(
    rpcUrl,
    deviceId,
    (device) => device.status === 'idle',
    scenario.idleTimeoutMs ?? 5_000,
  );
  const terminalStatuses = ['aborted', 'cancelled'];
  const passed = originalCancelResponse?.result?.cancelled === true &&
    originalTaskResponse?.error?.code === 'CANCELLED' &&
    terminalStatuses.includes(originalTerminal.entry?.result?.status) &&
    Boolean(restartTaskId) &&
    restartTaskId !== originalTaskId &&
    restartCancelResponse?.result?.cancelled === true &&
    restartTaskResponse?.error?.code === 'CANCELLED' &&
    terminalStatuses.includes(restartTerminal.entry?.result?.status) &&
    idle.device?.status === 'idle';

  return {
    iteration,
    deviceId,
    kind: 'cancel-restart',
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    cancellationLatencyMs,
    originalCancellationLatencyMs,
    restartCancellationLatencyMs,
    restartAcceptanceMs,
    idleConvergenceMs: idle.elapsedMs,
    passed,
    taskId: originalTaskId,
    restartTaskId,
    result: restartTaskResponse?.result ?? null,
    rpcError: restartTaskResponse?.error ?? null,
    originalTaskResponse,
    originalCancelResponse,
    restartTaskResponse,
    restartCancelResponse,
    phoneTerminalResult: originalTerminal.entry,
    restartPhoneTerminalResult: restartTerminal.entry,
    observedApps: [originalBusy.device?.currentApp, restartBusy.device?.currentApp].filter(Boolean),
    forbiddenApps: [],
    runtimeMismatches: [],
    policyDecisions: [],
    finalDevice: idle.device,
  };
}

function summarize(results, thresholds) {
  const byDevice = {};
  for (const result of results) {
    const entries = byDevice[result.deviceId] ?? [];
    entries.push(result);
    byDevice[result.deviceId] = entries;
  }

  const summarizeEntries = (entries) => {
    const passed = entries.filter((entry) => entry.passed).length;
    const idleValues = entries.map((entry) => entry.idleConvergenceMs).filter(Number.isFinite);
    const cancelValues = entries.map((entry) => entry.cancellationLatencyMs).filter(Number.isFinite);
    const restartValues = entries.map((entry) => entry.restartAcceptanceMs).filter(Number.isFinite);
    const durationValues = entries.map((entry) => entry.durationMs).filter(Number.isFinite);
    const forbiddenCount = entries.reduce((count, entry) => count + entry.forbiddenApps.length, 0);
    const residualBusyCount = entries.filter((entry) => entry.finalDevice?.status !== 'idle').length;
    return {
      runs: entries.length,
      passed,
      failed: entries.length - passed,
      successRate: entries.length === 0 ? 0 : passed / entries.length,
      idleP95Ms: percentile(idleValues, 0.95),
      idleMaxMs: idleValues.length === 0 ? null : Math.max(...idleValues),
      taskDurationP50Ms: percentile(durationValues, 0.5),
      taskDurationP95Ms: percentile(durationValues, 0.95),
      taskDurationMaxMs: durationValues.length === 0 ? null : Math.max(...durationValues),
      cancellationP95Ms: percentile(cancelValues, 0.95),
      cancellationMaxMs: cancelValues.length === 0 ? null : Math.max(...cancelValues),
      restartAcceptanceP95Ms: percentile(restartValues, 0.95),
      restartAcceptanceMaxMs: restartValues.length === 0 ? null : Math.max(...restartValues),
      forbiddenAppObservations: forbiddenCount,
      residualBusyCount,
    };
  };

  const deviceSummaries = Object.fromEntries(
    Object.entries(byDevice).map(([deviceId, entries]) => [deviceId, summarizeEntries(entries)]),
  );
  const overall = summarizeEntries(results);
  const checks = {
    minSuccessRate: overall.successRate >= (thresholds.minSuccessRate ?? 1),
    maxIdleP95Ms: overall.idleP95Ms != null && overall.idleP95Ms <= (thresholds.maxIdleP95Ms ?? 3_000),
    maxIdleMs: overall.idleMaxMs != null && overall.idleMaxMs <= (thresholds.maxIdleMs ?? 5_000),
    noForbiddenApps: overall.forbiddenAppObservations === 0,
    noResidualBusy: overall.residualBusyCount === 0,
  };
  if (results.some((entry) => entry.kind === 'cancel' || entry.kind === 'cancel-restart')) {
    checks.maxCancellationP95Ms = overall.cancellationP95Ms != null &&
      overall.cancellationP95Ms <= (thresholds.maxCancellationP95Ms ?? 2_000);
  }
  if (results.some((entry) => entry.kind === 'cancel-restart')) {
    checks.maxRestartAcceptanceP95Ms = overall.restartAcceptanceP95Ms != null &&
      overall.restartAcceptanceP95Ms <= (thresholds.maxRestartAcceptanceP95Ms ?? 2_000);
  }

  return {
    overall,
    devices: deviceSummaries,
    checks,
    passed: Object.values(checks).every(Boolean),
  };
}

function renderMarkdown(report) {
  const lines = [
    `# 真机发版门槛报告：${report.scenario.name}`,
    '',
    `- 开始时间：${report.startedAt}`,
    `- 结束时间：${report.finishedAt}`,
    `- 场景类型：${report.scenario.kind}`,
    `- 每台设备轮次：${report.scenario.iterations}`,
    `- 总体结果：${report.summary.passed ? '通过' : '失败'}`,
    '',
    '| 设备 | 轮次 | 通过 | 成功率 | 任务 P95 | idle P95 | 取消 P95 | 接管 P95 | 禁止 App | 残留 busy |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const [deviceId, summary] of Object.entries(report.summary.devices)) {
    lines.push(
      `| ${deviceId} | ${summary.runs} | ${summary.passed} | ${(summary.successRate * 100).toFixed(1)}% | ` +
      `${summary.taskDurationP95Ms ?? '-'} ms | ${summary.idleP95Ms ?? '-'} ms | ` +
      `${summary.cancellationP95Ms ?? '-'} ms | ` +
      `${summary.restartAcceptanceP95Ms ?? '-'} ms | ` +
      `${summary.forbiddenAppObservations} | ${summary.residualBusyCount} |`,
    );
  }
  lines.push('', '## 门槛检查', '');
  for (const [name, passed] of Object.entries(report.summary.checks)) {
    lines.push(`- [${passed ? 'x' : ' '}] ${name}`);
  }
  lines.push('', '## 失败明细', '');
  const failures = report.results.filter((result) => !result.passed);
  if (failures.length === 0) {
    lines.push('- 无');
  } else {
    for (const failure of failures) {
      lines.push(
        `- ${failure.deviceId} 第 ${failure.iteration} 轮：` +
        `${failure.rpcError?.code ?? failure.result?.status ?? 'UNKNOWN'} ` +
        `${failure.rpcError?.message ?? failure.result?.message ?? ''}`.trim(),
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', short: 'c' },
      device: { type: 'string', multiple: true },
      iterations: { type: 'string', short: 'n' },
      'rpc-url': { type: 'string' },
      'report-dir': { type: 'string' },
    },
  });
  if (!values.config) {
    fail('必须使用 --config 指定场景 JSON');
  }

  const configPath = path.resolve(values.config);
  const scenario = await readJson(configPath);
  scenario.kind ??= 'task';
  scenario.iterations = values.iterations == null ? scenario.iterations : Number(values.iterations);
  if (!scenario.name || !['task', 'cancel', 'cancel-restart'].includes(scenario.kind)) {
    fail('配置必须包含 name，kind 只能是 task、cancel 或 cancel-restart');
  }
  if (!Number.isInteger(scenario.iterations) || scenario.iterations < 1) {
    fail('iterations 必须是正整数');
  }
  if (!scenario.task?.task) fail('配置缺少 task.task');

  const rpcUrl = (values['rpc-url'] ?? process.env.TABBY_CONTROL_RPC_URL ?? DEFAULT_RPC_URL).replace(/\/$/, '');
  const reportDir = path.resolve(values['report-dir'] ?? process.env.TABBY_RELEASE_GATE_DIR ?? DEFAULT_REPORT_DIR);
  const initialDevices = await listDevices(rpcUrl);
  const requestedIds = values.device?.length ? values.device : scenario.deviceIds;
  const selected = requestedIds?.length
    ? requestedIds.map((deviceId) => initialDevices.find((device) => device.deviceId === deviceId))
    : initialDevices;
  if (selected.length === 0 || selected.some((device) => !device)) {
    fail(`找不到目标设备：${JSON.stringify(requestedIds ?? [])}`);
  }
  for (const device of selected) {
    if (device.status !== 'idle') fail(`设备 ${device.deviceId} 当前不是 idle，而是 ${device.status}`);
    const mismatches = checkExpectedDevice(device, scenario.expectedDevice);
    if (mismatches.length > 0) fail(`设备 ${device.deviceId} 运行配置不匹配：${mismatches.join('; ')}`);
  }

  const startedAt = new Date();
  const results = [];
  console.log(`[release-gate] 场景=${scenario.name} 设备=${selected.length} 每台轮次=${scenario.iterations}`);
  for (let iteration = 1; iteration <= scenario.iterations; iteration += 1) {
    const round = await Promise.all(selected.map(async (device) => {
      const run = scenario.kind === 'cancel'
        ? runCancelIteration
        : scenario.kind === 'cancel-restart'
          ? runCancelRestartIteration
          : runTaskIteration;
      try {
        return await run({ rpcUrl, scenario, deviceId: device.deviceId, iteration });
      } catch (error) {
        const idle = await waitForDevice(
          rpcUrl,
          device.deviceId,
          (current) => current.status === 'idle',
          scenario.idleTimeoutMs ?? 5_000,
        );
        return {
          iteration,
          deviceId: device.deviceId,
          kind: scenario.kind,
          startedAt: new Date().toISOString(),
          durationMs: null,
          idleConvergenceMs: idle.elapsedMs,
          passed: false,
          taskId: idle.device?.currentTaskId ?? null,
          result: null,
          rpcError: { code: 'HARNESS_ERROR', message: String(error) },
          observedApps: [],
          forbiddenApps: [],
          runtimeMismatches: [],
          policyDecisions: [],
          finalDevice: idle.device,
        };
      }
    }));
    results.push(...round);
    const roundText = round.map((entry) => `${entry.deviceId}:${entry.passed ? 'PASS' : 'FAIL'}`).join(' ');
    console.log(`[release-gate] ${iteration}/${scenario.iterations} ${roundText}`);
    if (iteration < scenario.iterations) await sleep(scenario.cooldownMs ?? 250);
  }

  const finalDevices = await listDevices(rpcUrl);
  const report = {
    schemaVersion: 1,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    rpcUrl,
    configPath,
    scenario,
    initialDevices: selected,
    finalDevices: finalDevices.filter((device) => selected.some((item) => item.deviceId === device.deviceId)),
    results,
    summary: summarize(results, scenario.thresholds ?? {}),
  };
  const baseName = `${isoFileTimestamp(startedAt)}-${sanitizeFileName(scenario.name)}`;
  await mkdir(reportDir, { recursive: true });
  const jsonPath = path.join(reportDir, `${baseName}.json`);
  const markdownPath = path.join(reportDir, `${baseName}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderMarkdown(report), 'utf8');
  console.log(`[release-gate] JSON: ${jsonPath}`);
  console.log(`[release-gate] 报告: ${markdownPath}`);
  console.log(`[release-gate] 结果: ${report.summary.passed ? 'PASS' : 'FAIL'}`);
  process.exitCode = report.summary.passed ? 0 : 1;
}

main().catch((error) => {
  console.error(String(error?.stack ?? error));
  process.exitCode = 1;
});
