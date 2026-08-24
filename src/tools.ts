/**
 * Tabby tool definitions
 *
 * All tools communicate with the Electron main-process bridge via HTTP RPC.
 * The bridge (exposed at http://localhost:18791) routes calls to the
 * WsServer / TaskCoordinator running in the Electron main process.
 */

import type { DeviceBridge } from './protocol.js';
import type { DeviceInfo, TaskResult, TaskPolicy } from './protocol.js';
import type { Orchestrator } from './orchestrator.js';
import type { DeviceRegistry } from './ws-server.js';

// ─── Tool factory helpers ─────────────────────────────────────────────────────

function formatDevices(devices: DeviceInfo[]): string {
  if (!devices.length) {
    return 'No devices connected. Open Tabby Agent app on your phone and connect to this PC.';
  }
  const lines = devices.map(d => {
    const parts = [
      d.manufacturer ?? d.model ?? d.deviceId,
      d.model ? `(${d.model})` : '',
      `status=${d.status}`,
      d.currentApp ? `app=${d.currentApp}` : '',
      d.screenWidth ? `screen=${d.screenWidth}x${d.screenHeight}` : '',
      d.osVersion ?? '',
      d.batteryLevel != null ? `🔋${d.batteryLevel}%` : '',
      d.isCharging ? '⚡' : '',
      d.wifiSsid ? `📶${d.wifiSsid}` : '',
      d.skillSyncStatus
        ? `skills=${d.skillSyncStatus}@${d.skillBundleVersion ?? 0}`
        : '',
      d.skillSyncError ? `skillError=${d.skillSyncError}` : '',
      d.deviceSkillLayerMode || d.devicePolicyMode
        ? `runtime=${d.deviceSkillLayerMode ?? 'off'}/${d.devicePolicyMode ?? 'off'}`
        : '',
      d.currentOperationClass ? `operation=${d.currentOperationClass}` : '',
      d.currentAppRole ? `role=${d.currentAppRole}` : '',
      d.activeSkills?.length ? `activeSkills=${d.activeSkills.join(',')}` : '',
      d.lastBlockedReason ? `lastBlocked=${d.lastBlockedReason}` : '',
    ].filter(Boolean);
    return `  - [${d.deviceId}] ${parts.join(' | ')}`;
  });
  return `📱 Connected devices (${devices.length}):\n${lines.join('\n')}`;
}

function formatTaskResult(result: TaskResult, deviceId: string): string {
  const sections: string[] = [];

  // Interaction needed: VLM paused, awaiting AI guidance
  if (result.needsInteraction) {
    sections.push(`⏸️ **Device VLM needs your decision (Interact)**`);
    sections.push(`Device: ${deviceId}`);
    sections.push(`Progress: ${result.totalSteps ?? 0} steps`);
    sections.push(`\nQuestion from device: ${result.interactionMessage ?? result.message ?? 'Unknown'}`);
    sections.push(`\nTo respond, call device_execute_task with:`);
    sections.push(`- deviceId: "${deviceId}"`);
    sections.push(`- task: the original task description`);
    sections.push(`- sessionId: "${result.taskId}"`);
    sections.push(`- guidance: your decision (e.g., "点击第一个选项", "滑动到底部查看更多")`);
    sections.push(`\nThat resume call stays open while the device keeps working and returns the`);
    sections.push(`task's REAL final result (or its next question). Respond promptly: the device`);
    sections.push(`only waits ~60s for guidance before continuing on its own judgement.`);
    if (result.interactionScreenshot) {
      sections.push(`\n📸 Current screen: ${result.interactionScreenshot}`);
    }
    return sections.join('\n');
  }

  if (result.success) {
    sections.push(`✅ Task completed`);
    if (result.message) sections.push(result.message);
    if (result.totalSteps !== undefined) sections.push(`Steps: ${result.totalSteps}`);
    if (result.duration !== undefined) sections.push(`Duration: ${(result.duration / 1000).toFixed(1)}s`);
    if (result.steps?.length) {
      for (const s of result.steps) {
        sections.push(`${s.step}. [${s.success ? '✅' : '❌'}] ${s.action}${s.target ? ` → ${s.target}` : ''}`);
      }
    }
  } else if (result.status === 'blocked') {
    sections.push(`🔒 Device requires user action: ${result.message ?? 'unlock or confirm on the phone, then retry'}`);
    if (result.errorCode) sections.push(`Policy code: ${result.errorCode}`);
    if (result.blockReason) sections.push(`Policy reason: ${result.blockReason}`);
    sections.push(`The device agent did not start the task. Resolve the condition on the phone before retrying.`);
    if (result.totalSteps !== undefined) sections.push(`Steps: ${result.totalSteps}`);
  } else if (result.status === 'aborted') {
    if (result.errorCode === 'CALLER_DISCONNECTED') {
      sections.push(`🛑 Task cancelled after the desktop/tool connection closed: ${result.message ?? 'no reason given'}`);
      sections.push(`This is a caller disconnect, not an on-device model decision. Report the interruption and do not re-run the task unless the user asks.`);
    } else if (result.errorCode === 'USER_CANCELLED') {
      sections.push(`🛑 Task cancelled by user request: ${result.message ?? 'no reason given'}`);
      sections.push(`Respect the cancellation and do not re-run the task unless the user explicitly asks.`);
    } else {
      sections.push(`🛑 Task aborted by the device agent: ${result.message ?? 'no reason given'}`);
      sections.push(`This was the on-device model's own decision, not a system error. Re-phrase the task or provide more specific guidance instead of retrying verbatim.`);
    }
    if (result.errorCode) sections.push(`Reason code: ${result.errorCode}`);
    if (result.totalSteps !== undefined) sections.push(`Steps before abort: ${result.totalSteps}`);
  } else if (result.status === 'stuck') {
    // The device reports the SAME status for two different causes: the
    // stuck-detector (no screen change across recent actions) and simply
    // running out of maxSteps while still making progress. Only the former
    // is actually stuck — the latter is a healthy task that needs to keep
    // going, and the session is kept alive on-device specifically for that.
    // Conflating them here previously told the model to "retry with
    // different guidance" for a task that had nothing wrong with it, so it
    // gave up instead of resuming.
    if (result.message?.startsWith('Task reached maximum steps')) {
      sections.push(`⏳ Task paused (ran out of its step budget, NOT stuck): ${result.message}`);
      sections.push(`The device was still making progress. To continue, call device_execute_task again with:`);
      sections.push(`- deviceId: "${deviceId}"`);
      sections.push(`- task: the original task description`);
      sections.push(`- sessionId: "${result.taskId}"`);
      sections.push(`- maxSteps: a larger budget if this keeps recurring`);
      sections.push(`That resume call continues from where the device left off, not from scratch.`);
    } else {
      sections.push(`🔁 Task stuck (no screen progress detected): ${result.message ?? 'Unknown'}`);
      sections.push(`Retrying with different guidance (e.g. an alternative entry point) may help.`);
    }
    if (result.totalSteps !== undefined) sections.push(`Steps: ${result.totalSteps}`);
  } else if (result.status === 'error') {
    // Infrastructure / on-device model failure (e.g. the phone's own VLM call
    // returned an error: no VLM credential on the device, model 401, gateway
    // unreachable). Surface the device's reported cause verbatim so the desktop
    // model relays it instead of guessing.
    const reason = result.message?.trim()
      ? result.message.trim()
      : "The device reported an infrastructure error but gave no detail. This is NOT a desktop login or credential problem — report the device-side failure as-is and suggest checking the phone's VLM/model settings.";
    sections.push(`❌ Device task errored (on-device infrastructure/model failure): ${reason}`);
    sections.push(`Relay this device-reported cause to the user. Do NOT invent a credential, login, or permission reason the device did not report.`);
    if (result.failedAtStep !== undefined) sections.push(`Failed at step ${result.failedAtStep}`);
    if (result.totalSteps !== undefined) sections.push(`Steps: ${result.totalSteps}`);
  } else {
    const reason = result.message?.trim()
      ? result.message.trim()
      : 'The device returned a failure with no message. Report the failure as-is; do NOT fabricate a credential, login, or permission cause the device did not report.';
    sections.push(`❌ Task failed${result.status ? ` (${result.status})` : ''}: ${reason}`);
    if (result.failedAtStep !== undefined) sections.push(`Failed at step ${result.failedAtStep}`);
    if (result.totalSteps !== undefined) sections.push(`Steps: ${result.totalSteps}`);
  }

  if (!result.success && result.duration !== undefined) {
    sections.push(`Duration: ${(result.duration / 1000).toFixed(1)}s`);
  }

  // Append final screenshot as file path (plugin saved it to taskData directory)
  if (result.finalScreenshot) {
    const isFilePath = result.finalScreenshot.startsWith('/');
    if (isFilePath) {
      sections.push(`\n📸 Final screenshot saved to: ${result.finalScreenshot}`);
    } else {
      // Fallback: inline base64 (should not reach here normally)
      sections.push(`\n📸 Final screenshot:\n![final screenshot](data:image/png;base64,${result.finalScreenshot})`);
    }
  }

  if (result.artifacts?.length) {
    sections.push(`\nTask artifacts (${result.artifacts.length}):`);
    for (const artifact of result.artifacts) {
      sections.push(`- ${artifact.name}: ${artifact.path} (${artifact.mimeType})`);
    }
  }

  return sections.join('\n');
}

/**
 * Render a bounded fan-out outcome. When the soft deadline hit first, the
 * still-running devices come back as a live job with explicit collection
 * instructions — the model follows instructions in tool RESULTS far more
 * reliably than advice in tool descriptions (the needsInteraction resume flow
 * is the working precedent).
 */
function formatBoundedOutcome(outcome: {
  jobId: string;
  done: boolean;
  results: Record<string, TaskResult>;
  pending: string[];
}): string {
  const settled = Object.keys(outcome.results).length
    ? formatBatchResults(outcome.results)
    : 'No device finished within the wait window.';
  if (outcome.done) return settled;
  return [
    settled,
    '',
    `⏳ NOT FINISHED: ${outcome.pending.length} device(s) still running: ${outcome.pending.join(', ')}.`,
    `The wait window closed but the phones keep working. jobId: ${outcome.jobId}`,
    'To collect the rest: call device_job_status with this jobId (poll until done:',
    'true, then pass includeResults). Do NOT re-dispatch these devices — the task',
    'is already running on them. device_cancel_job stops them if the user asks.',
  ].join('\n');
}

function formatBatchResults(results: Record<string, TaskResult>): string {
  const lines = ['Batch execution results:'];
  for (const [deviceId, result] of Object.entries(results)) {
    if (result.needsInteraction) {
      lines.push(`⏸️ [${deviceId}] ${result.interactionMessage ?? result.message ?? 'Device needs guidance'}`);
      lines.push(`  Resume with device_execute_task using sessionId: "${result.taskId}" and a guidance value.`);
      continue;
    }
    const icon = result.success ? '✅' : result.status === 'blocked' ? '🔒' : result.status === 'aborted' ? '🛑' : '❌';
    const msg = result.message ?? (result.success ? 'Done' : 'Failed');
    const statusTag = result.status && result.status !== 'completed' ? ` (${result.status})` : '';
    lines.push(`${icon} [${deviceId}] ${msg}${statusTag}`);
  }
  return lines.join('\n');
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

export function createDeviceListTool(client: DeviceBridge) {
  return {
    name: 'device_list',
    label: 'List Connected Devices',
    description: [
      'List all Android devices currently connected to Tabby.',
      'Returns device ID, model, OS version, screen size, task status, current app, and phone skill sync status.',
      'Use this first to discover available devices before sending tasks.',
    ].join(' '),
    parameters: { type: "object", properties: {} },
    async execute(): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
      try {
        const devices = await client.listDevices();
        return { content: [{ type: 'text', text: formatDevices(devices) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `device_list failed: ${msg}` }], isError: true };
      }
    },
  };
}

export function createExecuteTaskTool(client: DeviceBridge) {
  return {
    name: 'device_execute_task',
    label: 'Execute Task on Device',
    description: [
      'Send a natural language task to a connected Android device. The device runs its own',
      'autonomous agent loop (screenshot → vision model → action → repeat) and returns a',
      'structured result when done.',
      '',
      'IMPORTANT: Send the ENTIRE task to the device in one call. Do NOT split the task',
      'into sub-steps yourself. The device handles all steps autonomously. For example,',
      'if the user says "open WeChat and send a message to Zhang San", send the full',
      'task "打开微信给张三发消息：今晚吃饭吗" in one device_execute_task call.',
      '',
      '## Handling Interact Events',
      '',
      'The device VLM may pause with an Interact condition when it needs your decision.',
      'When this happens, you will receive an interaction_request event (via progress)',
      'with a screenshot of the current screen and a message explaining what it needs.',
      'You should:',
      '1. Analyze the screenshot to understand the current screen state',
      '2. Make a decision about what to do next',
      '3. Call device_execute_task with sessionId + guidance to resume the paused task',
      '   (use the same task description, add your decision as the guidance parameter)',
      '',
      'Examples:',
      '- "打开小红书，浏览首页前三屏内容" (NOT split into "open app" + "scroll" + "report")',
      '- "打开微信给张三发消息：今晚吃饭吗"',
      '- "在小红书搜索美食并截图"',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        deviceId: {
          type: 'string',
          description: 'Device ID from device_list',
        },
        task: {
          type: 'string',
          description: 'Natural language task description (Chinese or English)',
        },
        timeout: {
          type: 'number',
          description: 'Inactivity timeout in milliseconds — how long to wait with NO progress from the '
            + 'device before giving up (default: 300000, max: 600000). This is NOT a total runtime budget: '
            + 'the device reports progress every ~15s, so a task that keeps working runs as long as it needs.',
          default: 300000,
        },
        guidance: {
          type: 'string',
          description: 'Decision or instruction to resume a paused task (e.g., after an Interact event)',
        },
        sessionId: {
          type: 'string',
          description: 'Session ID from a previous task to resume',
        },
        maxSteps: {
          type: 'number',
          description: 'Maximum number of VLM steps (default: 50). Limits the autonomous agent loop iterations.',
        },
        allowedActions: {
          type: 'array',
          items: { type: 'string' },
          description: 'OPTIONAL, AND USUALLY OMIT IT. Whitelist of allowed action types; any action not '
            + 'listed is blocked by the phone and the task fails with POLICY_ACTION_NOT_ALLOWED. Leave '
            + 'unset unless the user or an explicit policy told you to restrict what the phone may do — '
            + 'the phone already applies its own safety policy. Names are validated against the action '
            + 'set the target device reported, and an unrecognised one is rejected with that device\'s '
            + 'full list rather than silently ignored, so you never need to guess: omit this, or send '
            + 'your best guess and read the error. Control actions (COMPLETE, ABORT, CALL_USER, INFO, '
            + 'BACK, WAIT) are always permitted and need not be listed.',
        },
        allowedApps: {
          type: 'array',
          items: { type: 'string' },
          description: 'OPTIONAL, AND USUALLY OMIT IT. Whitelist of allowed app names or packages '
            + '(e.g., ["微信", "com.tencent.mm"]). Only for AWAKE actions.',
        },
        taskPolicy: {
          type: 'object',
          description: 'OPTIONAL, AND USUALLY OMIT IT. Structured phone policy. It may narrow phone '
            + 'defaults but cannot enable browser APK installation or payment. Set it only when the user '
            + 'or an explicit policy asked you to restrict this run; do not add restrictions on your own '
            + 'initiative, and never describe a restriction you passed here as if the platform or the '
            + 'device imposed it — you chose it, so you can also drop it when the user asks you to. '
            + 'Unknown keys are rejected, so use only the properties listed below.',
          properties: {
            operationClass: {
              type: 'string',
              description: 'Semantic operation, e.g. app.install, account.login, content.publish.',
            },
            targetPackages: {
              type: 'array',
              items: { type: 'string' },
            },
            allowedAppRoles: {
              type: 'array',
              items: {
                type: 'string',
                enum: [
                  'target_app',
                  'official_store',
                  'system_installer',
                  'system_settings',
                  'default_sms',
                  'gallery',
                  'file_picker',
                  'browser',
                  'system_dialog',
                  'other',
                ],
              },
            },
            installSourcePolicy: {
              type: 'string',
              enum: ['official_store_only'],
            },
            allowBrowserDownload: { type: 'boolean' },
            allowedActions: {
              type: 'array',
              items: { type: 'string' },
            },
            allowedApps: {
              type: 'array',
              items: { type: 'string' },
            },
            confirmationPolicy: {
              type: 'object',
              properties: {
                login: { type: 'string', enum: ['required', 'forbidden'] },
                publish: { type: 'string', enum: ['required', 'forbidden'] },
                payment: { type: 'string', enum: ['forbidden'] },
              },
            },
          },
        },
      },
      required: ['deviceId', 'task'],
    },
    async execute(
      _id: string,
      params: { deviceId?: string; task?: string; timeout?: number; guidance?: string; sessionId?: string; maxSteps?: number; allowedActions?: string[]; allowedApps?: string[]; taskPolicy?: TaskPolicy },
    ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
      if (!params.deviceId || !params.task) {
        return { content: [{ type: 'text', text: 'deviceId and task are required.' }], isError: true };
      }
      try {
        const result = await client.executeTask(
          params.deviceId,
          params.task,
          Math.min(params.timeout ?? 300_000, 600_000),
          params.guidance,
          params.sessionId,
          params.maxSteps,
          params.allowedActions,
          params.allowedApps,
          params.taskPolicy,
        );
        const text = formatTaskResult(result, params.deviceId);
        return { content: [{ type: 'text', text }], isError: !result.success };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // msg is a prefixed transport/coordinator code (DEVICE_OFFLINE,
        // DEVICE_NOT_FOUND, TASK_ALREADY_RUNNING, TIMEOUT, or an invalid-result
        // reason). Surface it verbatim and forbid inventing a login/credential cause.
        return {
          content: [
            {
              type: 'text',
              text: `device_execute_task failed (transport/coordinator error): ${msg}\nReport this exact cause; do NOT substitute a credential or login reason the device did not report.`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}

export function createExecuteTaskAllTool(client: DeviceBridge) {
  return {
    name: 'device_execute_task_all',
    label: 'Execute Task on All Idle Devices',
    description: [
      'Send the same natural language task to ALL currently idle connected devices',
      'simultaneously and wait up to ~4 minutes. Devices that finish in time come',
      'back with full results; anything still running is returned as a live jobId',
      'to collect via device_job_status — nothing is lost either way. For fire-and-',
      'forget dispatch (no waiting at all), use device_dispatch_tasks.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Natural language task description',
        },
        timeout: {
          type: 'number',
          description: 'Per-device inactivity timeout in milliseconds — how long to wait with NO progress '
            + 'from a device before giving up on it (default: 300000). This is NOT a total runtime budget: '
            + 'a device that keeps reporting progress runs as long as its task needs.',
          default: 300000,
        },
      },
      required: ['task'],
    },
    async execute(
      _id: string,
      params: { task?: string; timeout?: number },
    ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
      if (!params.task) {
        return { content: [{ type: 'text', text: 'task is required.' }], isError: true };
      }
      try {
        const devices = await client.listDevices();
        const idle = devices.filter((d) => d.status === 'idle');
        if (!idle.length) {
          return {
            content: [{ type: 'text', text: 'DEVICE_OFFLINE: no idle devices.' }],
            isError: true,
          };
        }
        const outcome = await client.executeBatchBounded(
          idle.map((d) => ({ deviceId: d.deviceId, task: params.task as string })),
          Math.min(params.timeout ?? 300_000, 600_000),
        );
        return { content: [{ type: 'text', text: formatBoundedOutcome(outcome) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `device_execute_task_all failed: ${msg}` }],
          isError: true,
        };
      }
    },
  };
}

export function createDispatchTasksTool(client: DeviceBridge) {
  return {
    name: 'device_dispatch_tasks',
    label: 'Dispatch Tasks to Many Devices (does not wait)',
    description: [
      'THE DEFAULT WAY TO DRIVE PHONES. Sends a task to each',
      'listed device and returns a jobId immediately, in milliseconds, without',
      'waiting for any phone to finish. Poll device_job_status with that jobId to',
      'see how the fleet is doing, and device_cancel_job to stop what is left.',
      'Use this whenever two or more phones are involved, or the task repeats an',
      'action (each / every / one by one / batch) — without judging device count',
      'or estimating duration. The blocking alternatives wait for the slowest',
      'device and get the calling turn aborted past roughly 6 minutes, which loses',
      'the results of the phones that did succeed.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              deviceId: { type: 'string' },
              task: { type: 'string' },
              maxSteps: { type: 'number' },
            },
            required: ['deviceId', 'task'],
          },
          description: 'Array of { deviceId, task } pairs. Use the same task text for a fleet-wide sweep.',
        },
        timeout: {
          type: 'number',
          description: 'Per-device inactivity timeout in milliseconds (default: 300000). Not a total '
            + 'runtime budget: a device reporting progress runs as long as its task needs.',
          default: 300000,
        },
      },
      required: ['tasks'],
    },
    async execute(
      _id: string,
      params: { tasks?: Array<{ deviceId: string; task: string; maxSteps?: number }>; timeout?: number },
    ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
      if (!params.tasks?.length) {
        return {
          content: [{ type: 'text', text: 'tasks array is required and must not be empty.' }],
          isError: true,
        };
      }
      try {
        const { jobId, deviceCount } = await client.dispatchTasks(
          params.tasks,
          Math.min(params.timeout ?? 300_000, 600_000),
        );
        return {
          content: [{
            type: 'text',
            text: `🚀 Dispatched to ${deviceCount} device(s).\njobId: ${jobId}\n\n`
              + 'Nothing has finished yet — this call does not wait. Poll '
              + `device_job_status with jobId "${jobId}" to collect results.`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Dispatch failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  };
}

export function createJobStatusTool(client: DeviceBridge) {
  return {
    name: 'device_job_status',
    label: 'Check a Dispatched Job',
    description: [
      'Report how a device_dispatch_tasks job is going: how many devices are still',
      'running, how many succeeded, and every failure with its reason. Returns a',
      'summary by default because a few hundred phone transcripts will not fit in',
      'context; set includeResults to page through the successful ones.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'jobId returned by device_dispatch_tasks' },
        includeResults: {
          type: 'boolean',
          description: 'Include a page of successful device results. Omit while work is still running.',
        },
        offset: { type: 'number', description: 'Result page offset (with includeResults).' },
        limit: { type: 'number', description: 'Results per page, max 100 (default 20).' },
      },
      required: ['jobId'],
    },
    async execute(
      _id: string,
      params: { jobId?: string; includeResults?: boolean; offset?: number; limit?: number },
    ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
      if (!params.jobId) {
        return { content: [{ type: 'text', text: 'jobId is required.' }], isError: true };
      }
      try {
        const status = await client.getJobStatus(params.jobId, {
          includeResults: params.includeResults,
          offset: params.offset,
          limit: params.limit,
        }) as {
          total: number; running: number; succeeded: number; failed: number; done: boolean;
          ageMs: number;
          failures: Array<{ deviceId: string; taskId: string | null; error: string }>;
          truncatedFailures: number;
          results?: Array<{ deviceId: string; taskId: string | null; message: string }>;
          nextOffset?: number;
        };
        const lines = [
          `${status.done ? '✅ Job finished' : '⏳ Job running'} — ${Math.round(status.ageMs / 1000)}s elapsed`,
          `Devices: ${status.total} total | ${status.running} running | ${status.succeeded} succeeded | ${status.failed} failed`,
        ];
        if (status.failures.length) {
          lines.push('', 'Failures:');
          for (const f of status.failures) lines.push(`  ❌ [${f.deviceId}] ${f.error}`);
          if (status.truncatedFailures > 0) {
            lines.push(`  …and ${status.truncatedFailures} more failure(s) not listed.`);
          }
        }
        if (status.results?.length) {
          lines.push('', 'Results:');
          for (const r of status.results) lines.push(`  ✅ [${r.deviceId}] ${r.message}`);
          if (status.nextOffset != null) {
            lines.push(`  …more results available; call again with offset=${status.nextOffset}.`);
          }
        }
        if (!status.done) {
          lines.push('', 'Still running — poll again rather than starting new work on these devices.');
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      }
    },
  };
}

export function createCancelJobTool(client: DeviceBridge) {
  return {
    name: 'device_cancel_job',
    label: 'Cancel a Dispatched Job',
    description: 'Stop every device still running in a device_dispatch_tasks job. '
      + 'Devices that already finished are left alone.',
    parameters: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
    },
    async execute(
      _id: string,
      params: { jobId?: string },
    ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
      if (!params.jobId) {
        return { content: [{ type: 'text', text: 'jobId is required.' }], isError: true };
      }
      try {
        const { cancelled, failed } = await client.cancelJob(params.jobId);
        const lines = [`🛑 Cancelled ${cancelled} running device task(s).`];
        for (const f of failed) lines.push(`  ⚠️ [${f.deviceId}] ${f.error}`);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      }
    },
  };
}

export function createExecuteBatchTool(client: DeviceBridge) {
  return {
    name: 'device_execute_batch',
    label: 'Execute Different Tasks on Multiple Devices',
    description: [
      'Send different natural language tasks to different devices at the same time',
      'and wait up to ~4 minutes. Each device runs its own independent agent loop.',
      'Devices that finish in time come back with full results; anything still',
      'running is returned as a live jobId to collect via device_job_status —',
      'nothing is lost either way. For fire-and-forget dispatch (no waiting at',
      'all), use device_dispatch_tasks.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              deviceId: { type: 'string' },
              task: { type: 'string' },
            },
            required: ['deviceId', 'task'],
          },
          description: 'Array of { deviceId, task } pairs',
        },
        timeout: {
          type: 'number',
          description: 'Per-device inactivity timeout in milliseconds — how long to wait with NO progress '
            + 'from a device before giving up on it (default: 300000). This is NOT a total runtime budget: '
            + 'a device that keeps reporting progress runs as long as its task needs.',
          default: 300000,
        },
      },
      required: ['tasks'],
    },
    async execute(
      _id: string,
      params: {
        tasks?: Array<{ deviceId: string; task: string }>;
        timeout?: number;
      },
    ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
      if (!params.tasks?.length) {
        return {
          content: [{ type: 'text', text: 'tasks array is required and must not be empty.' }],
          isError: true,
        };
      }
      try {
        const outcome = await client.executeBatchBounded(
          params.tasks,
          Math.min(params.timeout ?? 300_000, 600_000),
        );
        return { content: [{ type: 'text', text: formatBoundedOutcome(outcome) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `device_execute_batch failed: ${msg}` }],
          isError: true,
        };
      }
    },
  };
}

export function createGetTaskResultsTool(client: DeviceBridge) {
  return {
    name: 'device_get_task_results',
    label: 'Recover Finished Task Results',
    description: [
      'Fetch results of tasks that already finished on a device.',
      'USE THIS when an execute call returned an error but the device may still have done the work —',
      'a cancelled or aborted request, a timeout, or a lost connection.',
      'The phone keeps working after the caller goes away, and its result is retained here,',
      'so check this before re-running the task and repeating the work.',
      'Omit taskId to list the most recent results, optionally narrowed to one device.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Exact task id to look up' },
        deviceId: { type: 'string', description: 'Only results from this device' },
        limit: { type: 'number', description: 'Max results when listing (default: 10)' },
      },
    },
    async execute(
      _id: string,
      params: { taskId?: string; deviceId?: string; limit?: number },
    ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
      try {
        const entries = await client.getTaskResults({
          taskId: params.taskId,
          deviceId: params.deviceId,
          limit: params.limit,
        });
        if (!entries.length) {
          return {
            content: [{
              type: 'text',
              text: 'No retained task results match. The task may still be running (check device_list), '
                + 'or its result has aged out.',
            }],
          };
        }
        const sections = entries.map(entry => {
          const age = Math.round((Date.now() - entry.completedAt) / 1000);
          const header = `── [${entry.deviceId}] ${entry.taskId} — finished ${age}s ago`
            + `${entry.orphaned ? ' (result was never collected)' : ''}`;
          return `${header}\n${formatTaskResult(entry.result, entry.deviceId)}`;
        });
        return { content: [{ type: 'text', text: sections.join('\n\n') }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `device_get_task_results failed: ${msg}` }],
          isError: true,
        };
      }
    },
  };
}

export function createCancelTaskTool(client: DeviceBridge) {
  return {
    name: 'device_cancel_task',
    label: 'Cancel Running Task',
    description:
      'Cancel a currently running task on a specified device. Omit taskId to cancel the current task.',
    parameters: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'Device ID' },
        taskId: {
          type: 'string',
          description: 'Task ID to cancel (from the execute response). Defaults to the current task.',
          default: 'current',
        },
      },
      required: ['deviceId'],
    },
    async execute(
      _id: string,
      params: { deviceId?: string; taskId?: string },
    ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
      if (!params.deviceId) {
        return {
          content: [{ type: 'text', text: 'deviceId is required.' }],
          isError: true,
        };
      }
      const taskId = params.taskId ?? 'current';
      try {
        await client.cancelTask(params.deviceId, taskId);
        return {
          content: [{
            type: 'text',
            text: `Task ${taskId} on device ${params.deviceId} has been cancelled.`,
          }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `device_cancel_task failed: ${msg}` }],
          isError: true,
        };
      }
    },
  };
}

export function createExecuteSkillTool(orchestrator: Orchestrator, _registry: DeviceRegistry) {
  return {
    name: 'device_execute_skill',
    label: 'Execute Task with Skill Orchestration',
    description: [
      'Execute a task using step-by-step sub-task orchestration.',
      'Accepts `steps` and `handlers` from the LLM; the orchestrator mechanically',
      'dispatches sub-tasks via the phone protocol.',
      '',
      'Benefits over device_execute_task:',
      '- Breaks complex tasks into reliable ≤3-step chunks',
      '- Injects step-specific hints (accessibility selectors, visual prompts)',
      '- Handles popups and interruptions via handler rules',
      '',
      'The device MUST have skill support enabled (Tabby Agent app v2+).',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        deviceId: {
          type: 'string',
          description: 'Device ID from device_list',
        },
        task: {
          type: 'string',
          description: 'Natural language task description (Chinese or English). Not needed for action="resume".',
        },
        timeout: {
          type: 'number',
          description: 'Overall orchestration timeout in milliseconds (default: 600000)',
          default: 600000,
        },
        steps: {
          type: 'array',
          description: 'Ordered list of steps for the LLM to execute on device',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Step name, e.g. "打开小红书首页"' },
              type: { type: 'string', enum: ['deterministic', 'flexible'], description: 'Step execution mode' },
              action: { type: 'string', description: 'Natural language action description' },
              prompt: { type: 'string', description: 'VLM prompt for flexible steps' },
              maxSteps: { type: 'number', description: 'Max VLM steps for this step' },
              validation: { type: 'string', description: 'How to validate success' },
            },
            required: ['name', 'type'],
          },
        },
        handlers: {
          type: 'array',
          description: 'Interrupt handling rules for this task',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Handler name, e.g. 广告弹窗' },
              trigger: { type: 'string', description: 'Natural language detection cue' },
              strategy: { type: 'string', enum: ['dismiss', 'ignore', 'report'], description: 'How to handle it' },
              action: { type: 'string', description: 'What to do (required for dismiss)' },
            },
            required: ['name', 'trigger', 'strategy'],
          },
          default: [],
        },
        action: {
          type: 'string',
          description: 'Action to perform. "start" (default) begins a new skill orchestration. "resume" resumes a paused orchestration after user confirmation.',
          enum: ['start', 'resume'],
          default: 'start',
        },
        confirmed: {
          type: 'boolean',
          description: 'Only for action="resume". true = user confirmed, proceed with execute phase. false = user cancelled, abort remaining.',
        },
        subtaskId: {
          type: 'string',
          description: 'Only for action="resume". The pendingSubTaskId from the needs_confirmation result.',
        },
        taskId: {
          type: 'string',
          description: 'Only for action="resume". The original orchestration taskId.',
        },
      },
      required: ['deviceId', 'task'],
    },
    async execute(
      _id: string,
      params: {
        deviceId?: string; task?: string; timeout?: number;
        steps?: Array<{ name: string; type: string; action?: string; prompt?: string; maxSteps?: number; validation?: string }>;
        handlers?: Array<{ name: string; trigger: string; strategy: string; action?: string }>;
        action?: string; confirmed?: boolean; subtaskId?: string; taskId?: string;
      },
    ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
      if (!params.deviceId) {
        return { content: [{ type: 'text', text: 'deviceId is required.' }], isError: true };
      }

      // ── Resume flow ──
      if (params.action === 'resume') {
        if (!params.taskId || !params.subtaskId || params.confirmed === undefined) {
          return { content: [{ type: 'text', text: 'For action="resume": taskId, subtaskId, and confirmed are required.' }], isError: true };
        }
        try {
          const result = await orchestrator.resumeOrchestration(
            params.deviceId, params.taskId, params.subtaskId, params.confirmed,
          );
          const sections: string[] = [];
          if (result.status === 'needs_confirmation') {
            const pendingContent = result.pendingContent as Record<string, unknown> | undefined;
            const pendingSubTaskId = result.pendingSubTaskId ?? '';
            const currentState = (pendingContent?.currentState as string) ?? '';
            const executeGoal = (pendingContent?.executeGoal as string) ?? '';
            const screenshot = (pendingContent?.screenshot as string) ?? '';

            sections.push(`⚠️ Confirmation required`);
            sections.push(``);
            sections.push(`Sub-task paused: ${pendingSubTaskId}`);
            if (executeGoal) sections.push(`Goal: ${executeGoal}`);
            if (currentState) sections.push(`Preview: ${currentState}`);
            if (screenshot) sections.push(`📸 Screenshot captured`);
            sections.push(``);
            sections.push(`To confirm: call device_execute_skill with action="resume", taskId="${params.taskId}", subtaskId="${pendingSubTaskId}", confirmed=true`);
            sections.push(`To cancel: call device_execute_skill with action="resume", taskId="${params.taskId}", subtaskId="${pendingSubTaskId}", confirmed=false`);

            return { content: [{ type: 'text', text: sections.join('\n') }], isError: false };
          }
          if (result.success) {
            sections.push(`✅ Skill task completed`);
          } else {
            sections.push(`❌ Skill task failed: ${result.message}`);
          }
          sections.push(`Sub-tasks completed: ${result.completedSubTasks.length}`);
          sections.push(`Sub-tasks failed: ${result.failedSubTasks.length}`);
          if (result.completedSubTasks.length > 0) {
            sections.push(`Completed: ${result.completedSubTasks.join(', ')}`);
          }
          if (result.failedSubTasks.length > 0) {
            sections.push(`Failed: ${result.failedSubTasks.join(', ')}`);
          }
          if (result.screenshots.length > 0) {
            sections.push(`\n📸 ${result.screenshots.length} screenshot(s) captured`);
          }

          return { content: [{ type: 'text', text: sections.join('\n') }], isError: !result.success };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: [{ type: 'text', text: `device_execute_skill resume failed: ${msg}` }], isError: true };
        }
      }

      // ── Start flow (default) ──
      if (!params.task) {
        return { content: [{ type: 'text', text: 'deviceId and task are required.' }], isError: true };
      }
      try {
        // Map LLM-provided steps and handlers to typed objects
        const steps = (params.steps ?? []).map(s => ({
          name: s.name,
          type: s.type as 'deterministic' | 'flexible',
          action: s.action,
          prompt: s.prompt,
          maxSteps: s.maxSteps,
          validation: s.validation,
        }));
        const handlers = (params.handlers ?? []).map(h => ({
          name: h.name,
          trigger: h.trigger,
          strategy: h.strategy as 'dismiss' | 'ignore' | 'report',
          action: h.action,
        }));

        const result = await orchestrator.executeSkillTask(
          params.deviceId,
          params.task,
          steps,
          handlers,
          Math.min(params.timeout ?? 600_000, 600_000),
        );

        const sections: string[] = [];
        if (result.status === 'needs_confirmation') {
          const pendingContent = result.pendingContent as Record<string, unknown> | undefined;
          const pendingSubTaskId = result.pendingSubTaskId ?? '';
          const currentState = (pendingContent?.currentState as string) ?? '';
          const executeGoal = (pendingContent?.executeGoal as string) ?? '';
          const screenshot = (pendingContent?.screenshot as string) ?? '';

          sections.push(`⚠️ Confirmation required`);
          sections.push(``);
          sections.push(`Sub-task paused: ${pendingSubTaskId}`);
          if (executeGoal) sections.push(`Goal: ${executeGoal}`);
          if (currentState) sections.push(`Preview: ${currentState}`);
          if (screenshot) sections.push(`📸 Screenshot captured`);
          sections.push(``);
          sections.push(`To confirm: call device_execute_skill with action="resume", taskId="${result.taskId}", subtaskId="${pendingSubTaskId}", confirmed=true`);
          sections.push(`To cancel: call device_execute_skill with action="resume", taskId="${result.taskId}", subtaskId="${pendingSubTaskId}", confirmed=false`);

          return { content: [{ type: 'text', text: sections.join('\n') }], isError: false };
        }
        if (result.success) {
          sections.push(`✅ Skill task completed`);
        } else {
          sections.push(`❌ Skill task failed: ${result.message}`);
        }
        sections.push(`Sub-tasks completed: ${result.completedSubTasks.length}`);
        sections.push(`Sub-tasks failed: ${result.failedSubTasks.length}`);
        if (result.completedSubTasks.length > 0) {
          sections.push(`Completed: ${result.completedSubTasks.join(', ')}`);
        }
        if (result.failedSubTasks.length > 0) {
          sections.push(`Failed: ${result.failedSubTasks.join(', ')}`);
        }
        if (result.screenshots.length > 0) {
          sections.push(`\n📸 ${result.screenshots.length} screenshot(s) captured`);
        }

        return { content: [{ type: 'text', text: sections.join('\n') }], isError: !result.success };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `device_execute_skill failed: ${msg}` }], isError: true };
      }
    },
  };
}

export function createGetStatusTool(client: DeviceBridge) {
  return {
    name: 'device_get_status',
    label: 'Get Device Detailed Status',
    description:
      'Get detailed status of a specific device including current app, running task, and connection info.',
    parameters: {
      type: 'object',
      properties: {
        deviceId: {
          type: 'string',
          description: 'Device ID from device_list',
        },
      },
      required: ['deviceId'],
    },
    async execute(
      _id: string,
      params: { deviceId?: string },
    ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
      if (!params.deviceId) {
        return { content: [{ type: 'text', text: 'deviceId is required.' }], isError: true };
      }
      try {
        const device = await client.getStatus(params.deviceId);
        if (!device) {
          return {
            content: [{ type: 'text', text: `Device ${params.deviceId} not found.` }],
            isError: true,
          };
        }
        // "busy" alone cannot distinguish a phone 12 steps into the work from
        // one that never started, which is what makes a caller cancel a
        // healthy long task. Report the last heartbeat so progress is visible
        // while the task is still running.
        const progress = client.getTaskProgress
          ? await client.getTaskProgress(params.deviceId).catch(() => null)
          : null;
        const lines = [
          `Device: ${device.model ?? device.deviceId}`,
          `Status: ${device.status}`,
          device.currentApp ? `Current app: ${device.currentApp}` : '',
          device.currentTaskId ? `Running task: ${device.currentTaskId}` : '',
          progress
            ? `Progress: step ${progress.step}`
              + (progress.progressPercent !== undefined ? ` (~${progress.progressPercent}%)` : '')
              + (progress.action ? `, last action ${progress.action}` : '')
              + (progress.target ? ` → ${progress.target}` : '')
              + `, ${Math.round((Date.now() - progress.at) / 1000)}s ago`
            : device.status === 'busy'
              ? 'Progress: no step heartbeat yet — the task may still be starting up'
              : '',
          device.screenWidth ? `Screen: ${device.screenWidth}x${device.screenHeight}` : '',
          device.osVersion ? `Android: ${device.osVersion}` : '',
          `Connected: ${new Date(device.connectedAt).toLocaleString()}`,
          `Last seen: ${new Date(device.lastSeen).toLocaleString()}`,
        ].filter(Boolean);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `device_get_status failed: ${msg}` }],
          isError: true,
        };
      }
    },
  };
}
