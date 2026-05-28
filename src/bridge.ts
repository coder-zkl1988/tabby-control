/**
 * HTTP RPC bridge client
 *
 * Used by the Tabby plugin to communicate with
 * the RPC server running at http://localhost:{rpcPort}.
 *
 * Falls back to HTTP when the plugin is loaded in a worker where
 * the WebSocket port is already bound by the gateway worker.
 */

import type { DeviceInfo, TaskResult, SubTaskExecuteParams, SubTaskResult, OrchestrationResult, ResumeParams, TaskStartParams, TaskEndParams } from './protocol.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface RpcRequest {
  method: string;
  params: Record<string, unknown>;
}

interface RpcResponse {
  id?: string;
  result?: unknown;
  error?: { code: string; message: string };
}

// ─── Bridge client ────────────────────────────────────────────────────────────

export class BridgeClient {
  private baseUrl: string;
  private requestTimeoutMs: number;

  constructor(rpcPort = 18801, requestTimeoutMs = 320_000) {
    this.baseUrl = `http://127.0.0.1:${rpcPort}`;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  /**
   * Perform an RPC call to the RPC server.
   * Throws on HTTP error or RPC-level error.
   */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, params } satisfies RpcRequest),
        signal: controller.signal,
      });

      const text = await (response as Response).text();
      if (!(response as Response).ok) {
        throw new Error(`Bridge HTTP ${(response as Response).status}: ${text.trim() || (response as Response).statusText}`);
      }

      const parsed = JSON.parse(text) as RpcResponse;
      if (parsed.error) {
        throw new Error(`${parsed.error.code}: ${parsed.error.message}`);
      }
      return (parsed.result ?? null) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Check if the bridge server is reachable. */
  async ping(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const response = await fetch(`${this.baseUrl}/health`, { signal: controller.signal });
      clearTimeout(timer);
      return (response as Response).ok;
    } catch {
      return false;
    }
  }

  // ─── Convenience wrappers ────────────────────────────────────────────────────

  async listDevices(): Promise<DeviceInfo[]> {
    return this.call<DeviceInfo[]>('device_list', {});
  }

  async executeTask(
    deviceId: string,
    task: string,
    timeoutMs = 300_000,
    guidance?: string,
    sessionId?: string,
    maxSteps?: number,
    allowedActions?: string[],
    allowedApps?: string[],
  ): Promise<TaskResult> {
    return this.call<TaskResult>('device_execute_task', {
      deviceId,
      task,
      timeoutMs,
      ...(guidance ? { guidance } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(maxSteps != null ? { maxSteps } : {}),
      ...(allowedActions?.length ? { allowedActions } : {}),
      ...(allowedApps?.length ? { allowedApps } : {}),
    });
  }

  async executeTaskAll(task: string, timeoutMs = 300_000): Promise<Record<string, TaskResult>> {
    return this.call<Record<string, TaskResult>>('device_execute_task_all', { task, timeoutMs });
  }

  async executeBatch(
    tasks: Array<{ deviceId: string; task: string }>,
    timeoutMs = 300_000,
  ): Promise<Record<string, TaskResult>> {
    return this.call<Record<string, TaskResult>>('device_execute_batch', { tasks, timeoutMs });
  }

  async cancelTask(deviceId: string, taskId: string): Promise<void> {
    await this.call('device_cancel_task', { deviceId, taskId });
  }

  async getStatus(deviceId: string): Promise<DeviceInfo | null> {
    return this.call<DeviceInfo | null>('device_get_status', { deviceId });
  }

  async executeSubTask(deviceId: string, params: SubTaskExecuteParams, timeoutMs?: number): Promise<SubTaskResult> {
    return this.call<SubTaskResult>('device_execute_subtask', {
      deviceId,
      ...params,
      timeoutMs,
    });
  }

  async resumeOrchestration(deviceId: string, params: ResumeParams): Promise<OrchestrationResult> {
    return this.call<OrchestrationResult>('device_resume_orchestration', { deviceId, ...params });
  }

  async sendTaskStart(deviceId: string, params: TaskStartParams): Promise<void> {
    await this.call('device_send_task_start', { deviceId, ...params });
  }

  async sendTaskEnd(deviceId: string, params: TaskEndParams): Promise<void> {
    await this.call('device_send_task_end', { deviceId, ...params });
  }
}
