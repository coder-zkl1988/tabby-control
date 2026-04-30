/**
 * OpenClaw tool definitions
 *
 * All tools communicate with the Electron main-process bridge via HTTP RPC.
 * The bridge (exposed at http://localhost:18791) routes calls to the
 * WsServer / TaskCoordinator running in the Electron main process.
 */

import type { DeviceBridge } from './protocol.js';
import type { DeviceInfo, TaskResult } from './protocol.js';

// ─── Tool factory helpers ─────────────────────────────────────────────────────

function formatDevices(devices: DeviceInfo[]): string {
  if (!devices.length) {
    return 'No devices connected. Open LobsterAgent app on your phone and connect to this PC.';
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
    sections.push(`\nTo respond, call device:execute_task with:`);
    sections.push(`- deviceId: "${deviceId}"`);
    sections.push(`- task: the original task description`);
    sections.push(`- sessionId: "${result.taskId}"`);
    sections.push(`- guidance: your decision (e.g., "点击第一个选项", "滑动到底部查看更多")`);
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
  } else {
    sections.push(`❌ Task failed: ${result.message ?? 'Unknown error'}`);
    if (result.failedAtStep !== undefined) sections.push(`Failed at step ${result.failedAtStep}`);
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

  return sections.join('\n');
}

function formatBatchResults(results: Record<string, TaskResult>): string {
  const lines = ['Batch execution results:'];
  for (const [deviceId, result] of Object.entries(results)) {
    const status = result.success ? '✅' : '❌';
    const msg = result.message ?? (result.success ? 'Done' : 'Failed');
    lines.push(`${status} [${deviceId}] ${msg}`);
  }
  return lines.join('\n');
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

export function createDeviceListTool(client: DeviceBridge) {
  return {
    name: 'device:list',
    label: 'List Connected Devices',
    description: [
      'List all Android devices currently connected to LobsterAI.',
      'Returns device ID, model, OS version, screen size, status (idle/busy/error), and current app.',
      'Use this first to discover available devices before sending tasks.',
    ].join(' '),
    parameters: {},
    async execute(): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
      try {
        const devices = await client.listDevices();
        return { content: [{ type: 'text', text: formatDevices(devices) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `device:list failed: ${msg}` }], isError: true };
      }
    },
  };
}

export function createExecuteTaskTool(client: DeviceBridge) {
  return {
    name: 'device:execute_task',
    label: 'Execute Task on Device',
    description: [
      'Send a natural language task to a connected Android device. The device runs its own',
      'autonomous agent loop (screenshot → vision model → action → repeat) and returns a',
      'structured result when done.',
      '',
      'IMPORTANT: Send the ENTIRE task to the device in one call. Do NOT split the task',
      'into sub-steps yourself. The device handles all steps autonomously. For example,',
      'if the user says "open WeChat and send a message to Zhang San", send the full',
      'task "打开微信给张三发消息：今晚吃饭吗" in one device:execute_task call.',
      '',
      '## Handling Interact Events',
      '',
      'The device VLM may pause with an Interact condition when it needs your decision.',
      'When this happens, you will receive an interaction_request event (via progress)',
      'with a screenshot of the current screen and a message explaining what it needs.',
      'You should:',
      '1. Analyze the screenshot to understand the current screen state',
      '2. Make a decision about what to do next',
      '3. Call device:execute_task with sessionId + guidance to resume the paused task',
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
          description: 'Device ID from device:list',
        },
        task: {
          type: 'string',
          description: 'Natural language task description (Chinese or English)',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 300000, max: 600000)',
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
          description: 'Whitelist of allowed action types (e.g., ["Tap", "Swipe", "Launch"]). Other actions will be blocked.',
        },
        allowedApps: {
          type: 'array',
          items: { type: 'string' },
          description: 'Whitelist of allowed app names or packages (e.g., ["微信", "com.tencent.mm"]). Only for Launch actions.',
        },
      },
      required: ['deviceId', 'task'],
    },
    async execute(
      _id: string,
      params: { deviceId?: string; task?: string; timeout?: number; guidance?: string; sessionId?: string; maxSteps?: number; allowedActions?: string[]; allowedApps?: string[] },
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
        );
        const text = formatTaskResult(result, params.deviceId);
        return { content: [{ type: 'text', text }], isError: !result.success };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `device:execute_task failed: ${msg}` }], isError: true };
      }
    },
  };
}

export function createExecuteTaskAllTool(client: DeviceBridge) {
  return {
    name: 'device:execute_task_all',
    label: 'Execute Task on All Idle Devices',
    description: [
      'Send the same natural language task to ALL currently idle connected devices simultaneously.',
      'Useful for parallel operations like "open WeChat on all devices".',
      'Returns a summary of results from each device.',
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
          description: 'Timeout per device in milliseconds (default: 300000)',
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
        const results = await client.executeTaskAll(
          params.task,
          Math.min(params.timeout ?? 300_000, 600_000),
        );
        return { content: [{ type: 'text', text: formatBatchResults(results) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `device:execute_task_all failed: ${msg}` }],
          isError: true,
        };
      }
    },
  };
}

export function createExecuteBatchTool(client: DeviceBridge) {
  return {
    name: 'device:execute_batch',
    label: 'Execute Different Tasks on Multiple Devices',
    description: [
      'Send different natural language tasks to different devices at the same time.',
      'Each device runs its own independent agent loop.',
      'Example: device A opens WeChat while device B opens DingTalk.',
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
          description: 'Timeout per device in milliseconds (default: 300000)',
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
        const results = await client.executeBatch(
          params.tasks,
          Math.min(params.timeout ?? 300_000, 600_000),
        );
        return { content: [{ type: 'text', text: formatBatchResults(results) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `device:execute_batch failed: ${msg}` }],
          isError: true,
        };
      }
    },
  };
}

export function createCancelTaskTool(client: DeviceBridge) {
  return {
    name: 'device:cancel_task',
    label: 'Cancel Running Task',
    description:
      'Cancel a currently running task on a specified device. Use after observing a task going wrong.',
    parameters: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'Device ID' },
        taskId: { type: 'string', description: 'Task ID to cancel (from the execute response)' },
      },
      required: ['deviceId', 'taskId'],
    },
    async execute(
      _id: string,
      params: { deviceId?: string; taskId?: string },
    ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
      if (!params.deviceId || !params.taskId) {
        return {
          content: [{ type: 'text', text: 'deviceId and taskId are required.' }],
          isError: true,
        };
      }
      try {
        await client.cancelTask(params.deviceId, params.taskId);
        return {
          content: [{
            type: 'text',
            text: `Task ${params.taskId} on device ${params.deviceId} has been cancelled.`,
          }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `device:cancel_task failed: ${msg}` }],
          isError: true,
        };
      }
    },
  };
}

export function createGetStatusTool(client: DeviceBridge) {
  return {
    name: 'device:get_status',
    label: 'Get Device Detailed Status',
    description:
      'Get detailed status of a specific device including current app, running task, and connection info.',
    parameters: {
      type: 'object',
      properties: {
        deviceId: {
          type: 'string',
          description: 'Device ID from device:list',
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
        const lines = [
          `Device: ${device.model ?? device.deviceId}`,
          `Status: ${device.status}`,
          device.currentApp ? `Current app: ${device.currentApp}` : '',
          device.currentTaskId ? `Running task: ${device.currentTaskId}` : '',
          device.screenWidth ? `Screen: ${device.screenWidth}x${device.screenHeight}` : '',
          device.osVersion ? `Android: ${device.osVersion}` : '',
          `Connected: ${new Date(device.connectedAt).toLocaleString()}`,
          `Last seen: ${new Date(device.lastSeen).toLocaleString()}`,
        ].filter(Boolean);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `device:get_status failed: ${msg}` }],
          isError: true,
        };
      }
    },
  };
}
