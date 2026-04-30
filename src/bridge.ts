/**
 * HTTP RPC bridge client
 *
 * Used by the OpenClaw plugin (in OpenClaw process) to communicate with
 * the Electron main-process bridge server running at http://localhost:18791.
 *
 * This file is the client counterpart of the Electron IPC handler that
 * exposes the WsServer / TaskCoordinator via a simple HTTP POST endpoint.
 */

import type { DeviceInfo, TaskResult } from './protocol.js';

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

  constructor(baseUrl = 'http://localhost:18791', requestTimeoutMs = 320_000) {
    this.baseUrl = baseUrl;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  /**
   * Perform an RPC call to the Electron bridge.
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
    return this.call<DeviceInfo[]>('device.list', {});
  }

  async executeTask(deviceId: string, task: string, timeoutMs = 300_000, guidance?: string, sessionId?: string): Promise<TaskResult> {
    if (guidance || sessionId) {
      console.warn(`[lobster-device-control] BridgeClient (HTTP) does not support guidance/sessionId — params ignored for device ${deviceId}`);
    }
    return this.call<TaskResult>('device.execute_task', { deviceId, task, timeoutMs });
  }

  async executeTaskAll(task: string, timeoutMs = 300_000): Promise<Record<string, TaskResult>> {
    return this.call<Record<string, TaskResult>>('device.execute_task_all', { task, timeoutMs });
  }

  async executeBatch(
    tasks: Array<{ deviceId: string; task: string }>,
    timeoutMs = 300_000,
  ): Promise<Record<string, TaskResult>> {
    return this.call<Record<string, TaskResult>>('device.execute_batch', { tasks, timeoutMs });
  }

  async cancelTask(deviceId: string, taskId: string): Promise<void> {
    await this.call('device.cancel_task', { deviceId, taskId });
  }

  async getStatus(deviceId: string): Promise<DeviceInfo | null> {
    return this.call<DeviceInfo | null>('device.get_status', { deviceId });
  }
}
