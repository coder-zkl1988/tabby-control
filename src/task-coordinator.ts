/**
 * TaskCoordinator
 *
 * Manages task dispatch to devices and result collection.
 * Bridges OpenClaw tool calls (via HTTP RPC bridge) and phone-side agent execution.
 *
 * Flow:
 *   OpenClaw tool → HTTP POST /rpc { method, params }
 *   → Electron IPC handler receives → TaskCoordinator.handleTaskMessage()
 *   → resolves pending Promise → tool returns result
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { homedir } from 'os';
import fs from 'fs';
import type { WsServer } from './ws-server.js';
import type {
  TaskId,
  DeviceId,
  ExecuteParams,
  ExecuteBatchParams,
  TaskResult,
} from './protocol.js';
import {
  TaskResultSchema,
  TaskIdSchema,
} from './protocol.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Screenshots go under ~/.openclaw/media/ which is whitelisted for Feishu media sending
const SCREENSHOT_DIR = join(homedir(), '.openclaw', 'media', 'lobster-screenshots');

// ─── Pending Request ──────────────────────────────────────────────────────────

interface PendingRequest {
  resolve: (value: TaskResult) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  deviceId: string;
}

// ─── ProgressCallback ────────────────────────────────────────────────────────

export interface ProgressCallback {
  (
    deviceId: string,
    step: number,
    action: string,
    target: string | undefined,
    progressPercent: number,
    thinking?: string,
  ): void;
}

// ─── TaskCoordinator ──────────────────────────────────────────────────────────

export class TaskCoordinator {
  private pending = new Map<TaskId, PendingRequest>();
  private progressCallbacks: ProgressCallback[] = [];
  private ipcNotifier: (channel: string, data: unknown) => void;
  private wsServer: WsServer;

  constructor(
    wsServer: WsServer,
    ipcNotifier: (channel: string, data: unknown) => void,
  ) {
    this.wsServer = wsServer;
    // Ensure taskData directory exists
    if (!fs.existsSync(SCREENSHOT_DIR)) {
      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
      console.log(`[lobster-device-control] Created screenshot dir: ${SCREENSHOT_DIR}`);
    }
    this.ipcNotifier = ipcNotifier;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Execute a natural language task on a single device.
   * Returns a Promise that resolves when the phone reports completion or timeout.
   */
  async executeTask(
    deviceId: string,
    task: string,
    timeoutMs = 300_000,
  ): Promise<TaskResult> {
    const device = this.wsServer.getRegistry().get(deviceId);
    if (!device) throw new Error(`DEVICE_NOT_FOUND: no device with id ${deviceId}`);
    if (device.info.status === 'busy') {
      throw new Error(`TASK_ALREADY_RUNNING: device ${deviceId} is busy`);
    }

    const taskId: TaskId = `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    this.wsServer.getRegistry().updateStatus(deviceId, {
      status: 'busy',
      currentTaskId: taskId,
    });
    this.ipcNotifier('device:status_change', { deviceId, status: 'busy', taskId });

    console.log(`[lobster-device-control] >>> EXECUTE_TASK >>> taskId=${taskId} deviceId=${deviceId} task="${task}" timeoutMs=${timeoutMs}`);

    const sent = this.wsServer.sendToDevice(deviceId, {
      channel: 'task',
      id: taskId,
      method: 'agent.execute',
      params: { taskId, task, mode: 'autonomous' } satisfies ExecuteParams,
    });

    if (!sent) {
      console.log(`[lobster-device-control] >>> EXECUTE_TASK >>> FAILED - device offline or not found, deviceId=${deviceId}`);
      this.wsServer.getRegistry().updateStatus(deviceId, {
        status: 'idle',
        currentTaskId: undefined,
      });
      throw new Error('DEVICE_OFFLINE');
    }

    return this.waitForResult(taskId, deviceId, timeoutMs);
  }

  /**
   * Execute the same task on all connected idle devices in parallel.
   */
  async executeTaskAll(
    task: string,
    timeoutMs = 300_000,
  ): Promise<Map<DeviceId, TaskResult>> {
    const devices = this.wsServer.getRegistry().list().filter(d => d.status === 'idle');
    if (devices.length === 0) throw new Error('DEVICE_OFFLINE: no idle devices');

    const results = new Map<DeviceId, TaskResult>();
    const promises = devices.map(async d => {
      try {
        const result = await this.executeTask(d.deviceId, task, timeoutMs);
        results.set(d.deviceId, result);
      } catch (err) {
        results.set(d.deviceId, {
          taskId: 'unknown',
          success: false,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
    await Promise.all(promises);
    return results;
  }

  /**
   * Execute different tasks on specified devices in parallel.
   */
  async executeBatch(
    tasks: Array<{ deviceId: DeviceId; task: string }>,
    timeoutMs = 300_000,
  ): Promise<Map<DeviceId, TaskResult>> {
    const results = new Map<DeviceId, TaskResult>();
    const promises = tasks.map(async ({ deviceId, task }) => {
      try {
        const result = await this.executeTask(deviceId, task, timeoutMs);
        results.set(deviceId, result);
      } catch (err) {
        results.set(deviceId, {
          taskId: 'unknown',
          success: false,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
    await Promise.all(promises);
    return results;
  }

  /**
   * Cancel a running task on a device.
   */
  cancelTask(deviceId: string, taskId: string): boolean {
    const sent = this.wsServer.sendToDevice(deviceId, {
      channel: 'task',
      id: `cancel_${taskId}`,
      method: 'agent.cancel',
      params: { taskId },
    });

    const pending = this.pending.get(taskId as TaskId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pending.delete(taskId as TaskId);
    }

    this.wsServer.getRegistry().updateStatus(deviceId, {
      status: 'idle',
      currentTaskId: undefined,
    });
    this.ipcNotifier('device:status_change', {
      deviceId,
      status: 'idle',
      taskId: undefined,
    });

    return sent;
  }

  /**
   * Get the current status of a device.
   */
  getDeviceStatus(deviceId: string) {
    return this.wsServer.getRegistry().get(deviceId)?.info ?? null;
  }

  /**
   * Subscribe to progress events (for UI display and OpenClaw decision hooks).
   */
  onProgress(callback: ProgressCallback): () => void {
    this.progressCallbacks.push(callback);
    return () => {
      this.progressCallbacks = this.progressCallbacks.filter(cb => cb !== callback);
    };
  }

  // ─── Screenshot file enrichment ─────────────────────────────────────────────

  /**
   * Decode base64 screenshot and save to taskData directory.
   * Replace the base64 string with the file path in the result.
   * Phone sends WebP-compressed JPEG data, saved as .webp for correct format.
   */
  private enrichResultWithScreenshot(taskResult: TaskResult): TaskResult {
    if (!taskResult.finalScreenshot) return taskResult;

    try {
      const filePath = join(SCREENSHOT_DIR, `${taskResult.taskId}.webp`);
      // Decode base64 and write WebP file
      const buffer = Buffer.from(taskResult.finalScreenshot, 'base64');
      fs.writeFileSync(filePath, buffer);
      console.log(`[lobster-device-control] Screenshot saved: ${filePath} (${buffer.length} bytes)`);
      // Return result with file path instead of base64
      return { ...taskResult, finalScreenshot: filePath };
    } catch (err) {
      console.warn(`[lobster-device-control] Failed to save screenshot: ${err}`);
      return taskResult; // Fallback: return original result with base64
    }
  }

  // ─── IPC Handler ────────────────────────────────────────────────────────────
  //
  // Called by the Electron main process IPC handler when a 'task' message
  // arrives from a phone via the WebSocket server.

  handleTaskMessage(deviceId: string, message: Record<string, unknown>): void {
    console.log(`[lobster-device-control] handleTaskMessage: deviceId=${deviceId}, id=${message.id}, hasResult=${!!message.result}, method=${message.method}`);

    // ── Result ────────────────────────────────────────────────────────────────
    if (message.result) {
      const result = message.result as Record<string, unknown>;
      // message.id is "resp_<taskId>" but pending map key is the raw taskId — strip prefix
      const rawId = (message.id as string) || (result.taskId as string);
      const taskId = rawId?.startsWith('resp_') ? rawId.slice(5) : rawId;
      console.log(`[lobster-device-control] RESULT: rawId=${rawId}, taskId=${taskId}, pendingKeys=${[...this.pending.keys()].join(',')}`);

      if (!taskId) return;

      const pending = this.pending.get(taskId as TaskId);
      console.log(`[lobster-device-control] pending.get(${taskId}) = ${pending ? 'FOUND' : 'NOT FOUND'}`);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(taskId as TaskId);

        const parsed = TaskResultSchema.safeParse(result);
        if (parsed.success) {
          // Replace base64 screenshot with file path
          const enriched = this.enrichResultWithScreenshot(parsed.data);
          pending.resolve(enriched);
        } else {
          pending.reject(new Error(`Invalid result from device: ${JSON.stringify(result)}`));
        }

        this.wsServer.getRegistry().updateStatus(deviceId, {
          status: 'idle',
          currentTaskId: undefined,
        });
        this.ipcNotifier('device:status_change', {
          deviceId,
          status: 'idle',
          taskId: undefined,
        });
        this.ipcNotifier('device:task_result', { deviceId, result: parsed.data ?? result });
      }
      return;
    }

    // ── Progress ─────────────────────────────────────────────────────────────
    if (message.method === 'agent.progress') {
      const params = message.params as Record<string, unknown>;
      for (const cb of this.progressCallbacks) {
        try {
          cb(
            deviceId,
            params.step as number,
            params.action as string,
            params.target as string | undefined,
            params.progressPercent as number,
            params.thinking as string | undefined,
          );
        } catch { /* ignore */ }
      }
      this.ipcNotifier('device:task_progress', { deviceId, params });
    }
  }

  // ─── Internal ────────────────────────────────────────────────────────────────

  private waitForResult(taskId: TaskId, deviceId: string, timeoutMs: number): Promise<TaskResult> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(taskId);
        this.wsServer.getRegistry().updateStatus(deviceId, {
          status: 'idle',
          currentTaskId: undefined,
        });
        reject(new Error(`TIMEOUT: task ${taskId} exceeded ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(taskId, {
        resolve,
        reject,
        timeout,
        deviceId,
      });
    });
  }
}
