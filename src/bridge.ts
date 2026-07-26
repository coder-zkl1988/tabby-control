/**
 * HTTP RPC bridge client
 *
 * Used by the Tabby plugin to communicate with
 * the RPC server running at http://localhost:{rpcPort}.
 *
 * Falls back to HTTP when the plugin is loaded in a worker where
 * the WebSocket port is already bound by the gateway worker.
 */

import type { DeviceInfo, TaskResult, SubTaskExecuteParams, SubTaskResult, OrchestrationResult, ResumeParams, TaskStartParams, TaskEndParams, CachedTaskResult, TaskResultQuery, TaskPolicy } from './protocol.js';

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

// ─── Deadlines ────────────────────────────────────────────────────────────────

/**
 * Transport deadline for a call whose server-side deadline is *hard*: the
 * server is guaranteed to answer within its own `timeoutMs`, so we allow that
 * plus enough slack for dispatch and serialisation.
 */
const TRANSPORT_HEADROOM_MS = 30_000;

/**
 * Sentinel for "this call has no client-side wall clock".
 *
 * `TaskCoordinator.waitForResult` deliberately uses an *idle* timeout that
 * every `agent.progress` heartbeat re-arms, so a healthy phone task legitimately
 * runs far past any fixed duration. A transport wall clock here would abort
 * tasks that are still making progress and orphan the phone, which is exactly
 * the bug a hardcoded 320s deadline used to cause. The coordinator settles on
 * every path, so it is the single deadline authority for agent-loop calls.
 */
const NO_TRANSPORT_DEADLINE = null;

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
   *
   * `timeoutMs` is the transport deadline: it defaults to the client-wide
   * fast-fail budget for control-plane calls, and is `NO_TRANSPORT_DEADLINE`
   * for calls that drive the phone's agent loop.
   */
  async call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs: number | null = this.requestTimeoutMs,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = timeoutMs === null ? null : setTimeout(() => controller.abort(), timeoutMs);

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
      if (timer) clearTimeout(timer);
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
    taskPolicy?: TaskPolicy,
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
      ...(taskPolicy ? { taskPolicy } : {}),
    }, NO_TRANSPORT_DEADLINE);
  }

  async executeTaskAll(task: string, timeoutMs = 300_000): Promise<Record<string, TaskResult>> {
    return this.call<Record<string, TaskResult>>(
      'device_execute_task_all',
      { task, timeoutMs },
      NO_TRANSPORT_DEADLINE,
    );
  }

  async executeBatch(
    tasks: Array<{ deviceId: string; task: string }>,
    timeoutMs = 300_000,
  ): Promise<Record<string, TaskResult>> {
    return this.call<Record<string, TaskResult>>(
      'device_execute_batch',
      { tasks, timeoutMs },
      NO_TRANSPORT_DEADLINE,
    );
  }

  async getTaskResults(query: TaskResultQuery): Promise<CachedTaskResult[]> {
    return this.call<CachedTaskResult[]>('device_get_task_results', { ...query });
  }

  async cancelTask(deviceId: string, taskId: string): Promise<void> {
    await this.call('device_cancel_task', { deviceId, taskId });
  }

  async getStatus(deviceId: string): Promise<DeviceInfo | null> {
    return this.call<DeviceInfo | null>('device_get_status', { deviceId });
  }

  async executeSubTask(deviceId: string, params: SubTaskExecuteParams, timeoutMs?: number): Promise<SubTaskResult> {
    // A subtask's server-side deadline is hard (no heartbeat re-arming), so a
    // derived transport deadline is honest here — unlike the agent-loop calls.
    return this.call<SubTaskResult>('device_execute_subtask', {
      deviceId,
      ...params,
      timeoutMs,
    }, (timeoutMs ?? 60_000) + TRANSPORT_HEADROOM_MS);
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
