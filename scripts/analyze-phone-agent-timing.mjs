import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

function fail(message) {
  console.error(`[phone-agent-timing] ${message}`);
  process.exit(1);
}

function percentile(values, ratio) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

function summarize(values) {
  return {
    count: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: values.length === 0 ? null : Math.max(...values),
  };
}

function parseLog(text, source) {
  const tasks = [];
  let active = null;
  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(/^\s*(\d+\.\d+)\s+\d+\s+\d+\s+[A-Z]\s+(PhoneAgentRunner|AgentForegroundService):\s?(.*)$/u);
    if (!match) continue;
    const atMs = Math.round(Number(match[1]) * 1000);
    const tag = match[2];
    const message = match[3];

    const received = tag === 'AgentForegroundService'
      ? message.match(/Received task\[(.+?)\]:/u)
      : null;
    if (received) {
      if (active) tasks.push(active);
      active = {
        taskId: received[1],
        source,
        receivedAtMs: atMs,
        firstActionAtMs: null,
        actionAtMs: [],
        vlmMs: [],
        completedAtMs: null,
      };
      continue;
    }
    if (!active) continue;

    const vlm = message.match(/VLM 响应耗时:\s*(\d+)ms/u);
    if (vlm) active.vlmMs.push(Number(vlm[1]));

    if (message.includes('解析到动作:')) {
      active.actionAtMs.push(atMs);
      active.firstActionAtMs ??= atMs;
    }

    if (message.includes('任务完成:') || message.includes('Task cancelled at step')) {
      active.completedAtMs = atMs;
    }
    if (tag === 'AgentForegroundService' && message.includes('setState: Connected')) {
      active.completedAtMs ??= atMs;
      tasks.push(active);
      active = null;
    }
  }
  if (active) tasks.push(active);
  return tasks;
}

function buildReport(label, tasks, releaseGate) {
  const gateByTaskId = new Map(
    (releaseGate?.results ?? [])
      .filter((entry) => entry.taskId)
      .map((entry) => [entry.taskId, entry]),
  );
  const matched = tasks.filter((task) => gateByTaskId.has(task.taskId));
  const complete = matched.filter((task) => task.firstActionAtMs != null && task.completedAtMs != null);
  const taskRows = complete.map((task) => {
    const gate = gateByTaskId.get(task.taskId);
    const actionIntervalsMs = task.actionAtMs.slice(1).map((atMs, index) => atMs - task.actionAtMs[index]);
    return {
      taskId: task.taskId,
      source: task.source,
      success: Boolean(gate?.passed),
      steps: gate?.result?.totalSteps ?? task.actionAtMs.length,
      firstActionMs: task.firstActionAtMs - task.receivedAtMs,
      vlmMs: task.vlmMs,
      actionIntervalsMs,
      totalMs: gate?.durationMs ?? task.completedAtMs - task.receivedAtMs,
    };
  });
  const successful = taskRows.filter((task) => task.success);
  const allVlmMs = successful.flatMap((task) => task.vlmMs);
  const allActionIntervalsMs = successful.flatMap((task) => task.actionIntervalsMs);
  return {
    label,
    releaseGate: releaseGate
      ? { startedAt: releaseGate.startedAt, finishedAt: releaseGate.finishedAt }
      : null,
    coverage: {
      releaseGateTasks: gateByTaskId.size,
      matchedLogTasks: matched.length,
      completeLogTasks: complete.length,
    },
    summary: {
      runs: taskRows.length,
      passed: successful.length,
      successRate: taskRows.length === 0 ? 0 : successful.length / taskRows.length,
      firstAction: summarize(successful.map((task) => task.firstActionMs)),
      vlmResponse: summarize(allVlmMs),
      actionInterval: summarize(allActionIntervalsMs),
      total: summarize(successful.map((task) => task.totalMs)),
    },
    tasks: taskRows,
  };
}

const { values } = parseArgs({
  options: {
    label: { type: 'string' },
    log: { type: 'string', multiple: true },
    report: { type: 'string' },
  },
});

if (!values.label) fail('缺少 --label');
if (!values.log?.length) fail('至少提供一个 --log');
if (!values.report) fail('缺少 --report');

const releaseGate = JSON.parse(await readFile(values.report, 'utf8'));
const tasks = (
  await Promise.all(values.log.map(async (file) => parseLog(await readFile(file, 'utf8'), file)))
).flat();
console.log(JSON.stringify(buildReport(values.label, tasks, releaseGate), null, 2));
