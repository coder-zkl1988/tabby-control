/**
 * TaskCoordinator
 *
 * Manages task dispatch to devices and result collection.
 * Bridges Tabby tool calls (via HTTP RPC bridge) and phone-side agent execution.
 *
 * Flow:
 *   Tabby tool → HTTP POST /rpc { method, params }
 *   → Electron IPC handler receives → TaskCoordinator.handleTaskMessage()
 *   → resolves pending Promise → tool returns result
 */

import { join } from 'path';
import { homedir } from 'os';
import fs from 'fs';
import type { WsServer } from './ws-server.js';
import type {
  TaskId,
  DeviceId,
  TaskResult,
  SubTaskResult,
  SubTaskExecuteParams,
  OrchestrationResult,
  ResumeParams,
  TaskStartParams,
  TaskEndParams,
  MediaPushResult,
  TaskArtifact,
  CachedTaskResult,
  TaskPolicy,
  DeviceInfo,
} from './protocol.js';
import {
  TaskResultSchema,
  SubTaskResultSchema,
  OrchestrationResultSchema,
  MediaPushResultSchema,
  AgentArtifactParamsSchema,
  TaskPolicySchema,
} from './protocol.js';
import { randomUUID } from 'crypto';

// Screenshots go under ~/.openclaw/media/ which is whitelisted for Feishu media sending
const SCREENSHOT_DIR = join(homedir(), '.openclaw', 'media', 'tabby-screenshots');
const TASK_ARTIFACT_DIR = join(SCREENSHOT_DIR, 'artifacts');
const MAX_TASK_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_TASK_ARTIFACTS = 32;

/** Bounds on the completed-result cache that backs post-hoc recovery. */
const MAX_CACHED_TASK_RESULTS = 64;
const TASK_RESULT_TTL_MS = 30 * 60_000;
const MAX_CLOSED_TASKS = 128;

function artifactExtension(mimeType: string): string {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  return 'jpg';
}

function hasExpectedImageSignature(buffer: Buffer, mimeType: string): boolean {
  if (mimeType === 'image/jpeg') {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimeType === 'image/png') {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  return buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
}

// ─── Pending Request ──────────────────────────────────────────────────────────

interface PendingRequest {
  resolve: (value: TaskResult) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  deviceId: string;
  /** Re-arm the idle timeout — called on every agent.progress heartbeat. */
  rearm: () => void;
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
  private activeTasks = new Map<DeviceId, TaskId>();
  private closedTasks = new Map<TaskId, number>();
  private subTaskPending = new Map<string, {
    resolve: (value: SubTaskResult) => void;
    reject: (reason: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
    deviceId: string;
  }>();
  private orchestrationPending = new Map<string, {
    resolve: (value: OrchestrationResult) => void;
    reject: (reason: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
    deviceId: string;
  }>();
  private mediaPending = new Map<string, {
    resolve: (value: MediaPushResult) => void;
    reject: (reason: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private taskArtifacts = new Map<TaskId, TaskArtifact[]>();
  private taskResults = new Map<TaskId, CachedTaskResult>();
  private taskCancellationSources = new Map<
    TaskId,
    'user_requested' | 'caller_disconnected'
  >();
  /**
   * Transport task id of a dispatched guidance resume → the original task it
   * carries guidance for. The phone replies to the transport id with a bare
   * "guidance received" acknowledgement; that reply must be suppressed (it is
   * NOT a task result) while the caller keeps awaiting the ORIGINAL task.
   */
  private guidanceAckIds = new Map<TaskId, TaskId>();
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
      console.log(`[tabby-control] Created screenshot dir: ${SCREENSHOT_DIR}`);
    }
    fs.mkdirSync(TASK_ARTIFACT_DIR, { recursive: true });
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
    guidance?: string,
    sessionId?: string,
    maxSteps?: number,
    allowedActions?: string[],
    allowedApps?: string[],
    taskPolicy?: TaskPolicy,
  ): Promise<TaskResult> {
    const device = this.wsServer.getRegistry().get(deviceId);
    if (!device) throw new Error(`DEVICE_NOT_FOUND: no device with id ${deviceId}`);
    const validatedTaskPolicy = taskPolicy
      ? TaskPolicySchema.parse(taskPolicy)
      : undefined;
    const activeTaskId = this.getActiveTaskId(deviceId);
    const isResume = guidance != null
      && sessionId != null
      && activeTaskId === sessionId;
    if (!isResume && guidance != null && sessionId != null) {
      // Guidance arrived after the original task already ended on its own
      // (e.g. the phone's 60s interaction window expired and the loop ran to
      // completion). Re-running the whole task blind would repeat minutes of
      // work — return the task's actual outcome instead, clearly labelled.
      const retained = this.taskResults.get(sessionId as TaskId);
      if (retained) {
        console.log(
          `[tabby-control] Guidance for finished task ${sessionId} — returning retained result instead of re-running`,
        );
        return {
          ...retained.result,
          message: '[Guidance arrived after the task had already finished on its own; '
            + 'it was NOT applied. Below is the task\'s actual final result.]\n'
            + (retained.result.message ?? ''),
        };
      }
    }
    if (!isResume && (activeTaskId || device.info.status === 'busy')) {
      throw new Error(`TASK_ALREADY_RUNNING: device ${deviceId} is busy`);
    }
    if (isResume && this.pending.has(sessionId as TaskId)) {
      throw new Error(
        `RESUME_IN_FLIGHT: a previous guidance call is still awaiting task ${sessionId}; `
        + 'wait for it to return instead of sending another',
      );
    }

    const taskId: TaskId = `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    if (!isResume) {
      this.activeTasks.set(deviceId, taskId);
    }

    this.wsServer.getRegistry().updateStatus(deviceId, {
      status: 'busy',
      currentTaskId: isResume ? activeTaskId : taskId,
    });
    this.ipcNotifier('device:status_change', {
      deviceId,
      status: 'busy',
      taskId: isResume ? activeTaskId : taskId,
    });

    console.log(
      `[tabby-control] >>> EXECUTE_TASK >>> taskId=${taskId}`
      + `${isResume ? ` (guidance resume of ${sessionId})` : ''}`
      + ` deviceId=${deviceId} task="${task}" timeoutMs=${timeoutMs}`,
    );

    const params: Record<string, unknown> = {
      taskId, task, mode: 'autonomous' as const,
    };
    if (maxSteps) params.maxSteps = maxSteps;
    if (guidance) params.guidance = guidance;
    if (sessionId) params.sessionId = sessionId;
    if (allowedActions) params.allowedActions = allowedActions;
    if (allowedApps) params.allowedApps = allowedApps;
    if (validatedTaskPolicy) params.taskPolicy = validatedTaskPolicy;

    const sent = this.wsServer.sendToDevice(deviceId, {
      channel: 'task',
      id: taskId,
      method: 'agent.execute',
      params,
    });

    if (!sent) {
      console.log(`[tabby-control] >>> EXECUTE_TASK >>> FAILED - device offline or not found, deviceId=${deviceId}`);
      if (!isResume) {
        this.updateDeviceAfterTaskExit(deviceId, taskId);
      }
      throw new Error('DEVICE_OFFLINE');
    }

    if (isResume) {
      // The transport task only ferries the guidance; the phone answers it with
      // a bare acknowledgement (suppressed in handleTaskMessage). What the
      // caller actually cares about is the ORIGINAL task, so await that id:
      // its progress heartbeats re-arm this timer, a second INFO resolves it
      // with needsInteraction again, and its terminal result resolves it with
      // the real outcome — instead of the misleading "completed / 0 steps" ack.
      this.guidanceAckIds.set(taskId, sessionId as TaskId);
      while (this.guidanceAckIds.size > 64) {
        const oldest = this.guidanceAckIds.keys().next();
        if (oldest.done) break;
        this.guidanceAckIds.delete(oldest.value);
      }
      return this.waitForResult(sessionId as TaskId, deviceId, timeoutMs);
    }

    return this.waitForResult(taskId, deviceId, timeoutMs);
  }

  /**
   * Push an image into the device gallery. Resolves with the saved content URI
   * once the phone confirms. Uses the `task` channel + a media-specific pending
   * map (id `media_<mediaId>`) so it reuses handleTaskMessage's correlation.
   */
  async pushMedia(
    deviceId: string,
    media: { filename: string; mimeType: string; dataBase64: string },
    timeoutMs = 30_000,
  ): Promise<MediaPushResult> {
    const mediaId = randomUUID();
    const sent = this.wsServer.sendToDevice(deviceId, {
      channel: 'task',
      id: `media_${mediaId}`,
      method: 'media.push',
      params: { mediaId, ...media },
    });
    if (!sent) {
      throw new Error('DEVICE_OFFLINE');
    }
    return new Promise<MediaPushResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.mediaPending.delete(mediaId);
        reject(new Error('TIMEOUT'));
      }, timeoutMs);
      this.mediaPending.set(mediaId, { resolve, reject, timeout });
    });
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
   * Execute a sub-task on a device and wait for its result.
   */
  async executeSubTask(deviceId: string, params: SubTaskExecuteParams, timeoutMs = 60_000): Promise<SubTaskResult> {
    const device = this.wsServer.getRegistry().get(deviceId);
    if (!device) throw new Error(`DEVICE_NOT_FOUND: no device with id ${deviceId}`);

    const subtaskId = params.subtaskId;

    // Send subtask.execute to phone
    const sent = this.wsServer.sendToDevice(deviceId, {
      channel: 'task',
      id: `sub_${subtaskId}`,
      method: 'subtask.execute',
      params,
    });

    if (!sent) throw new Error('DEVICE_OFFLINE');

    return this.waitForSubTaskResult(subtaskId, deviceId, timeoutMs);
  }

  /**
   * Resume a paused orchestration (confirm/deny a needs_confirmation sub-task).
   */
  async resumeOrchestration(deviceId: string, params: ResumeParams): Promise<OrchestrationResult> {
    const device = this.wsServer.getRegistry().get(deviceId);
    if (!device) throw new Error(`DEVICE_NOT_FOUND: no device with id ${deviceId}`);

    const sent = this.wsServer.sendToDevice(deviceId, {
      channel: 'task',
      id: `resume_${params.subtaskId}`,
      method: 'orchestration.resume',
      params,
    });

    if (!sent) throw new Error('DEVICE_OFFLINE');

    return this.waitForOrchestrationResult(params.taskId, deviceId);
  }

  /**
   * Send task.start to a device with interrupt handler rules.
   */
  async sendTaskStart(deviceId: string, params: TaskStartParams): Promise<void> {
    const sent = this.wsServer.sendToDevice(deviceId, {
      channel: 'task',
      method: 'task.start',
      params: {
        taskId: params.taskId,
        handlers: params.handlers,
      },
    });
    if (!sent) throw new Error('DEVICE_OFFLINE: failed to send task.start');
  }

  /**
   * Send task.end to a device to signal task completion.
   */
  async sendTaskEnd(deviceId: string, params: TaskEndParams): Promise<void> {
    this.wsServer.sendToDevice(deviceId, {
      channel: 'task',
      method: 'task.end',
      params: { taskId: params.taskId },
    });
  }

  /**
   * Cancel a running task on a device.
   */
  cancelTask(
    deviceId: string,
    taskId: string,
    source: 'user_requested' | 'caller_disconnected' = 'user_requested',
  ): void {
    const device = this.wsServer.getRegistry().get(deviceId);
    if (!device) {
      throw new Error(`DEVICE_NOT_FOUND: no device with id ${deviceId}`);
    }
    const activeTaskId = this.getActiveTaskId(deviceId);
    const resolvedTaskId = taskId === 'current' ? activeTaskId : taskId;
    if (!resolvedTaskId) {
      throw new Error(`TASK_NOT_FOUND: device ${deviceId} has no current task`);
    }
    if (activeTaskId && resolvedTaskId !== activeTaskId) {
      throw new Error(
        `TASK_NOT_FOUND: task ${resolvedTaskId} is not current task ${activeTaskId} on device ${deviceId}`,
      );
    }

    const sent = this.wsServer.sendToDevice(deviceId, {
      channel: 'task',
      id: `cancel_${resolvedTaskId}`,
      method: 'agent.cancel',
      params: { taskId: resolvedTaskId },
    });
    if (!sent) {
      throw new Error(`DEVICE_OFFLINE: failed to cancel task on device ${deviceId}`);
    }

    this.taskCancellationSources.set(resolvedTaskId as TaskId, source);
    this.markTaskClosed(resolvedTaskId as TaskId);
    const pending = this.pending.get(resolvedTaskId as TaskId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pending.delete(resolvedTaskId as TaskId);
      pending.reject(new Error('CANCELLED'));
    }
    this.taskArtifacts.delete(resolvedTaskId as TaskId);
    this.updateDeviceAfterTaskExit(deviceId, resolvedTaskId as TaskId);
  }

  /**
   * Get the current status of a device.
   */
  getDeviceStatus(deviceId: string) {
    return this.wsServer.getRegistry().get(deviceId)?.info ?? null;
  }

  /**
   * Subscribe to progress events (for UI display and Tabby decision hooks).
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
  private enrichResultWithScreenshot(
    taskId: TaskId,
    taskResult: TaskResult,
    artifacts: TaskArtifact[] = [],
  ): TaskResult {
    // Artifact paths are desktop-owned. Never trust paths supplied by a phone in
    // the task result; only attach files persisted by the artifact handler.
    let enriched: TaskResult = { ...taskResult, artifacts: undefined };
    if (taskResult.finalScreenshot) {
      try {
        const safeTaskId = taskId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
        const filePath = join(SCREENSHOT_DIR, `${safeTaskId}.webp`);
        const buffer = Buffer.from(taskResult.finalScreenshot, 'base64');
        fs.writeFileSync(filePath, buffer);
        console.log(`[tabby-control] Screenshot saved: ${filePath} (${buffer.length} bytes)`);
        enriched = { ...enriched, finalScreenshot: filePath };
      } catch (err) {
        console.warn(`[tabby-control] Failed to save screenshot: ${err}`);
      }
    }
    if (artifacts.length > 0) {
      enriched = {
        ...enriched,
        artifacts: [...(enriched.artifacts ?? []), ...artifacts],
      };
    }
    return enriched;
  }

  // ─── IPC Handler ────────────────────────────────────────────────────────────
  //
  // Called by the Electron main process IPC handler when a 'task' message
  // arrives from a phone via the WebSocket server.

  handleTaskMessage(deviceId: string, message: Record<string, unknown>): void {
    console.log(`[tabby-control] handleTaskMessage: deviceId=${deviceId}, id=${message.id}, hasResult=${!!message.result}, method=${message.method}`);

    // Route sub-task messages to their own handler
    const method = message.method as string;
    if (method?.startsWith('subtask.')) {
      this.handleSubTaskMessage(deviceId, message);
      return;
    }

    // ── Task artifact ───────────────────────────────────────────────────────
    if (method === 'agent.artifact') {
      const parsed = AgentArtifactParamsSchema.safeParse(message.params);
      if (!parsed.success) {
        console.warn(`[tabby-control] Invalid task artifact: ${parsed.error.message}`);
        return;
      }

      const params = parsed.data;
      const taskId = params.taskId as TaskId;
      const pending = this.pending.get(taskId);
      if (!pending || pending.deviceId !== deviceId) {
        console.warn(`[tabby-control] Ignoring artifact for inactive task ${taskId}`);
        return;
      }
      if (params.dataBase64.length > Math.ceil(MAX_TASK_ARTIFACT_BYTES * 4 / 3) + 8) {
        console.warn(`[tabby-control] Artifact ${params.artifactId} exceeds size limit`);
        return;
      }

      const current = this.taskArtifacts.get(taskId) ?? [];
      if (current.some(item => item.artifactId === params.artifactId)) {
        pending.rearm();
        return;
      }
      if (current.length >= MAX_TASK_ARTIFACTS) {
        console.warn(`[tabby-control] Artifact count limit reached for ${taskId}`);
        return;
      }

      try {
        const buffer = Buffer.from(params.dataBase64, 'base64');
        if (buffer.length === 0 || buffer.length > MAX_TASK_ARTIFACT_BYTES) {
          throw new Error(`invalid artifact size ${buffer.length}`);
        }
        if (!hasExpectedImageSignature(buffer, params.mimeType)) {
          throw new Error(`artifact bytes do not match ${params.mimeType}`);
        }
        const name = params.name.trim().slice(0, 256);
        if (!name) throw new Error('artifact name is blank');
        const safeTaskId = taskId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
        const safeId = params.artifactId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96) || 'artifact';
        const taskArtifactDir = join(TASK_ARTIFACT_DIR, safeTaskId);
        fs.mkdirSync(taskArtifactDir, { recursive: true });
        const filePath = join(
          taskArtifactDir,
          `${safeId}.${artifactExtension(params.mimeType)}`,
        );
        fs.writeFileSync(filePath, buffer);
        const artifact: TaskArtifact = {
          artifactId: params.artifactId,
          name,
          mimeType: params.mimeType,
          path: filePath,
        };
        const updatedArtifacts = [...current, artifact];
        fs.writeFileSync(
          join(taskArtifactDir, 'manifest.json'),
          JSON.stringify({
            taskId,
            deviceId,
            updatedAt: new Date().toISOString(),
            artifacts: updatedArtifacts,
          }, null, 2),
        );
        this.taskArtifacts.set(taskId, updatedArtifacts);
        pending.rearm();
        this.ipcNotifier('device:task_artifact', { deviceId, taskId, artifact });
        console.log(`[tabby-control] Task artifact saved: ${filePath} (${buffer.length} bytes)`);
      } catch (err) {
        console.warn(`[tabby-control] Failed to save task artifact: ${err}`);
      }
      return;
    }

    // ── Media push result ───────────────────────────────────────────────────
    // id is "resp_media_<mediaId>" (echoed back from our "media_<mediaId>").
    {
      const rawId = (message.id as string) || '';
      const idBody = rawId.startsWith('resp_') ? rawId.slice(5) : rawId;
      if (idBody.startsWith('media_')) {
        const mediaId = idBody.slice('media_'.length);
        const entry = this.mediaPending.get(mediaId);
        if (entry) {
          clearTimeout(entry.timeout);
          this.mediaPending.delete(mediaId);
          const parsed = MediaPushResultSchema.safeParse(message.result);
          if (parsed.success) entry.resolve(parsed.data);
          else
            entry.reject(
              new Error(`Invalid media result: ${JSON.stringify(message.result)}`),
            );
        }
        return;
      }
    }

    // ── Result ────────────────────────────────────────────────────────────────
    if (message.result) {
      const result = message.result as Record<string, unknown>;
      // message.id is "resp_<taskId>" but pending map key is the raw taskId — strip prefix
      const rawId = (message.id as string) || (result.taskId as string);
      const taskId = rawId?.startsWith('resp_') ? rawId.slice(5) : rawId;
      console.log(`[tabby-control] RESULT: rawId=${rawId}, taskId=${taskId}, pendingKeys=${[...this.pending.keys()].join(',')}`);

      if (!taskId) return;

      const guidanceAckFor = this.guidanceAckIds.get(taskId as TaskId);
      if (guidanceAckFor) {
        // Transport-level acknowledgement of a delivered guidance resume — not
        // a real task result. Ack it so the phone's persistent result store
        // stops re-sending it, and keep the caller awaiting the original task.
        this.guidanceAckIds.delete(taskId as TaskId);
        this.wsServer.sendToDevice(deviceId, {
          channel: 'task',
          method: 'agent.result_ack',
          params: { taskId },
        });
        console.log(
          `[tabby-control] Guidance delivered for ${guidanceAckFor} (transport ${taskId}); original task still running`,
        );
        return;
      }

      this.markTaskClosed(taskId as TaskId);

      const pending = this.pending.get(taskId as TaskId);
      console.log(`[tabby-control] pending.get(${taskId}) = ${pending ? 'FOUND' : 'NOT FOUND'}`);

      if (pending && pending.deviceId !== deviceId) {
        console.warn(`[tabby-control] Ignoring task result from wrong device for ${taskId}`);
        return;
      }

      const parsed = TaskResultSchema.safeParse(result);
      const parsedResult = parsed.success && parsed.data.taskId === taskId
        ? parsed.data
        : null;
      if (parsed.success && !parsedResult) {
        console.warn(`[tabby-control] Task result id mismatch: envelope=${taskId}, result=${parsed.data.taskId}`);
      }

      const cancellationSource = this.taskCancellationSources.get(taskId as TaskId);
      this.taskCancellationSources.delete(taskId as TaskId);
      const validResult = parsedResult?.status === 'aborted' && cancellationSource
        ? {
            ...parsedResult,
            errorCode: cancellationSource === 'caller_disconnected'
              ? 'CALLER_DISCONNECTED'
              : 'USER_CANCELLED',
            message: cancellationSource === 'caller_disconnected'
              ? 'Task cancelled because the desktop/tool connection closed before completion'
              : 'Task cancelled by user request before completion',
          }
        : parsedResult;

      const retained = validResult ? this.taskResults.get(taskId as TaskId) : undefined;
      if (retained) {
        if (retained.deviceId !== deviceId) {
          console.warn(`[tabby-control] Ignoring replayed task result from wrong device for ${taskId}`);
          return;
        }
        this.wsServer.sendToDevice(deviceId, {
          channel: 'task',
          method: 'agent.result_ack',
          params: { taskId },
        });
        console.log(`[tabby-control] Duplicate task result acknowledged: ${taskId}`);
        return;
      }

      const artifacts = this.taskArtifacts.get(taskId as TaskId) ?? [];
      this.taskArtifacts.delete(taskId as TaskId);
      const enriched = validResult
        ? this.enrichResultWithScreenshot(taskId as TaskId, validResult, artifacts)
        : result;
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(taskId as TaskId);

        if (validResult) {
          pending.resolve(enriched as TaskResult);
        } else {
          pending.reject(new Error(`Invalid result from device: ${JSON.stringify(result)}`));
        }
      }

      // Retain the result even when nobody was awaiting it, so an aborted or
      // timed-out caller can still recover the work the phone actually did.
      if (validResult) {
        this.rememberTaskResult(taskId as TaskId, deviceId, enriched as TaskResult, !pending);
        const structuredResult = enriched as TaskResult;
        if (structuredResult.status === 'blocked') {
          this.wsServer.getRegistry().updateStatus(deviceId, {
            lastPolicyDecision: structuredResult.policyDecision ?? 'block',
            lastPolicyCode: structuredResult.errorCode,
            lastBlockedReason: structuredResult.blockReason ?? structuredResult.message,
          });
        }
      }

      // A guidance acknowledgement has its own transport task id while the
      // original phone loop remains active. Only clear the task that actually
      // owns the device.
      this.updateDeviceAfterTaskExit(deviceId, taskId as TaskId);
      this.ipcNotifier('device:task_result', { deviceId, result: enriched });
      if (validResult) {
        this.wsServer.sendToDevice(deviceId, {
          channel: 'task',
          method: 'agent.result_ack',
          params: { taskId },
        });
      }
      return;
    }

    // ── Progress ─────────────────────────────────────────────────────────────
    if (message.method === 'agent.progress') {
      const params = message.params as Record<string, unknown>;
      const progressTaskId = params.taskId ? String(params.taskId) as TaskId : undefined;
      const runtime = params.runtime as {
        operationClass?: string;
        currentAppRole?: string;
        selectedSkills?: string[];
        skippedSkills?: string[];
        skillLayerMode?: string;
        policyMode?: string;
        policyDecision?: string;
        policyCode?: string;
      } | undefined;

      if (progressTaskId) {
        const device = this.wsServer.getRegistry().get(deviceId);
        const activeTaskId = this.activeTasks.get(deviceId) ?? device?.info.currentTaskId;
        if (this.isTaskClosed(progressTaskId)) {
          console.warn(`[tabby-control] Ignoring progress for closed task ${progressTaskId}`);
          return;
        }
        if (activeTaskId && activeTaskId !== progressTaskId) {
          console.warn(
            `[tabby-control] Ignoring stale progress for ${progressTaskId}; ` +
            `active task is ${activeTaskId}`,
          );
          return;
        }
        this.activeTasks.set(deviceId, progressTaskId);
        if (
          device
          && (device.info.status !== 'busy' || device.info.currentTaskId !== progressTaskId)
        ) {
          this.wsServer.getRegistry().updateStatus(deviceId, {
            status: 'busy',
            currentTaskId: progressTaskId,
          });
          this.ipcNotifier('device:status_change', {
            deviceId,
            status: 'busy',
            taskId: progressTaskId,
          });
        }
      }
      if (runtime) {
        this.wsServer.getRegistry().updateStatus(deviceId, {
          currentOperationClass: runtime.operationClass,
          currentAppRole: runtime.currentAppRole as DeviceInfo['currentAppRole'],
          activeSkills: runtime.selectedSkills,
          skippedSkills: runtime.skippedSkills,
          deviceSkillLayerMode: runtime.skillLayerMode as DeviceInfo['deviceSkillLayerMode'],
          devicePolicyMode: runtime.policyMode as DeviceInfo['devicePolicyMode'],
          lastPolicyDecision: runtime.policyDecision as DeviceInfo['lastPolicyDecision'],
          lastPolicyCode: runtime.policyCode,
        });
      }

      // Heartbeat: any progress means the task is alive — re-arm its idle
      // timeout so a long-but-active task (browsing, 养号) isn't killed by
      // waitForResult while the phone is still stepping.
      this.pending.get(String(params.taskId ?? '') as TaskId)?.rearm();

      // Forward interaction_request to Tabby via IPC (VLM needs decision)
      const interactionReq = params.interaction_request as { message: string; screenshot?: string } | undefined;
      if (interactionReq) {
        let screenshotForIpc: string | undefined = interactionReq.screenshot;
        if (screenshotForIpc) {
          try {
            const buffer = Buffer.from(screenshotForIpc, 'base64');
            const filePath = join(SCREENSHOT_DIR, `interaction_${params.taskId}_step${params.step}.webp`);
            fs.writeFileSync(filePath, buffer);
            screenshotForIpc = filePath;
          } catch (err) {
            console.warn(`[tabby-control] Failed to save interaction screenshot: ${err}`);
          }
        }

        // Notify Electron IPC subscribers (for desktop mode)
        this.ipcNotifier('device:interaction_request', {
          deviceId,
          taskId: params.taskId,
          step: params.step,
          screenshot: screenshotForIpc,
          message: interactionReq.message,
        });

        // Resolve the pending task Promise so the AI (Tabby) can analyze the
        // screenshot and decide. The phone waits 60s for a guidance reply.
        const taskId = String(params.taskId);
        const pending = this.pending.get(taskId as TaskId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pending.delete(taskId as TaskId);

          pending.resolve({
            taskId,
            success: false,
            message: interactionReq.message,
            totalSteps: params.step as number,
            needsInteraction: true,
            interactionMessage: interactionReq.message,
            interactionScreenshot: screenshotForIpc,
          });
        }
      }

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

  private getActiveTaskId(deviceId: DeviceId): TaskId | undefined {
    const registry = this.wsServer.getRegistry();
    const device = registry.get(deviceId);
    const activeTaskId = this.activeTasks.get(deviceId) ?? device?.info.currentTaskId;

    // A fresh phone connection or idle heartbeat is authoritative. Drop any
    // in-memory task left behind by a lost terminal result.
    if (device?.info.status === 'idle') {
      this.activeTasks.delete(deviceId);
      if (device.info.currentTaskId) {
        registry.updateStatus(deviceId, { currentTaskId: undefined });
      }
      return undefined;
    }

    return activeTaskId;
  }

  private markTaskClosed(taskId: TaskId): void {
    this.closedTasks.delete(taskId);
    this.closedTasks.set(taskId, Date.now());
    this.pruneClosedTasks();
  }

  private isTaskClosed(taskId: TaskId): boolean {
    this.pruneClosedTasks();
    return this.closedTasks.has(taskId);
  }

  private pruneClosedTasks(): void {
    const cutoff = Date.now() - TASK_RESULT_TTL_MS;
    for (const [taskId, closedAt] of this.closedTasks) {
      if (closedAt < cutoff) {
        this.closedTasks.delete(taskId);
        this.taskCancellationSources.delete(taskId);
      }
    }
    while (this.closedTasks.size > MAX_CLOSED_TASKS) {
      const oldest = this.closedTasks.keys().next();
      if (oldest.done) break;
      this.closedTasks.delete(oldest.value);
      this.taskCancellationSources.delete(oldest.value);
    }
  }

  private updateDeviceAfterTaskExit(deviceId: DeviceId, taskId: TaskId): void {
    const registry = this.wsServer.getRegistry();
    const registryTaskId = registry.get(deviceId)?.info.currentTaskId;
    const activeTaskId = this.activeTasks.get(deviceId) ?? registryTaskId;

    if (activeTaskId === taskId) {
      this.activeTasks.delete(deviceId);
      registry.updateStatus(deviceId, {
        status: 'idle',
        currentTaskId: undefined,
      });
      this.ipcNotifier('device:status_change', {
        deviceId,
        status: 'idle',
        taskId: undefined,
      });
      return;
    }

    if (activeTaskId) {
      registry.updateStatus(deviceId, {
        status: 'busy',
        currentTaskId: activeTaskId,
      });
      this.ipcNotifier('device:status_change', {
        deviceId,
        status: 'busy',
        taskId: activeTaskId,
      });
      return;
    }

    registry.updateStatus(deviceId, {
      status: 'idle',
      currentTaskId: undefined,
    });
    this.ipcNotifier('device:status_change', {
      deviceId,
      status: 'idle',
      taskId: undefined,
    });
  }

  /** Look up a finished task's result by id. Null once it ages out. */
  getTaskResult(taskId: string): CachedTaskResult | null {
    this.pruneTaskResults();
    return this.taskResults.get(taskId as TaskId) ?? null;
  }

  /**
   * Finished task results, newest first. Filters to one device when given a
   * `deviceId` — the usual shape of "the batch aborted, what did it get?".
   */
  getRecentTaskResults(deviceId?: string, limit = 10): CachedTaskResult[] {
    this.pruneTaskResults();
    const entries = [...this.taskResults.values()]
      .filter(entry => deviceId == null || entry.deviceId === deviceId)
      .sort((a, b) => b.completedAt - a.completedAt);
    return entries.slice(0, limit);
  }

  private rememberTaskResult(
    taskId: TaskId,
    deviceId: string,
    result: TaskResult,
    orphaned: boolean,
  ): void {
    this.taskResults.set(taskId, { taskId, deviceId, result, completedAt: Date.now(), orphaned });
    if (orphaned) {
      console.warn(
        `[tabby-control] Result for ${taskId} arrived with no waiter — cached for recovery`,
      );
    }
    this.pruneTaskResults();
  }

  private pruneTaskResults(): void {
    const cutoff = Date.now() - TASK_RESULT_TTL_MS;
    for (const [taskId, entry] of this.taskResults) {
      if (entry.completedAt < cutoff) this.taskResults.delete(taskId);
    }
    // Map iterates in insertion order, and task ids are unique, so the first
    // key is always the oldest surviving entry.
    while (this.taskResults.size > MAX_CACHED_TASK_RESULTS) {
      const oldest = this.taskResults.keys().next();
      if (oldest.done) break;
      this.taskResults.delete(oldest.value);
    }
  }

  private waitForResult(taskId: TaskId, deviceId: string, timeoutMs: number): Promise<TaskResult> {
    return new Promise((resolve, reject) => {
      // Idle timeout, not a total wall-clock budget: a phone task can legitimately
      // run for many minutes (browsing, 养号), and it sends agent.progress every
      // ~15s. Each progress heartbeat re-arms this timer (see agent.progress
      // handler), so we only give up when the phone goes silent for timeoutMs.
      const onTimeout = () => {
        this.pending.delete(taskId);
        this.taskArtifacts.delete(taskId);
        this.markTaskClosed(taskId);
        this.updateDeviceAfterTaskExit(deviceId, taskId);
        reject(new Error(`TIMEOUT: task ${taskId} made no progress for ${timeoutMs}ms`));
      };

      this.pending.set(taskId, {
        resolve,
        reject,
        timeout: setTimeout(onTimeout, timeoutMs),
        deviceId,
        rearm: () => {
          const entry = this.pending.get(taskId);
          if (!entry) return;
          clearTimeout(entry.timeout);
          entry.timeout = setTimeout(onTimeout, timeoutMs);
        },
      });
    });
  }

  private waitForSubTaskResult(subtaskId: string, deviceId: string, timeoutMs: number): Promise<SubTaskResult> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.subTaskPending.delete(subtaskId);
        reject(new Error(`SUBTASK_TIMEOUT: ${subtaskId} after ${timeoutMs}ms`));
      }, timeoutMs);

      this.subTaskPending.set(subtaskId, { resolve, reject, timeout, deviceId });
    });
  }

  private waitForOrchestrationResult(taskId: string, deviceId: string, timeoutMs = 30_000): Promise<OrchestrationResult> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.orchestrationPending.delete(taskId);
        reject(new Error(`ORCHESTRATION_RESUME_TIMEOUT: ${taskId} after ${timeoutMs}ms`));
      }, timeoutMs);

      this.orchestrationPending.set(taskId, { resolve, reject, timeout, deviceId });
    });
  }

  handleSubTaskMessage(deviceId: string, message: Record<string, unknown>): void {
    const method = message.method as string;

    if (method === 'subtask.result') {
      const raw = message.params as Record<string, unknown>;
      const subtaskId = raw.subtaskId as string;
      const pending = this.subTaskPending.get(subtaskId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.subTaskPending.delete(subtaskId);
        try {
          const result = SubTaskResultSchema.parse(raw);
          pending.resolve(result);
        } catch (err) {
          pending.reject(new Error(`Invalid subtask result: ${err}`));
        }
      }
    } else if (method === 'subtask.heartbeat') {
      // Forward heartbeat for monitoring/logging
      console.log(`[TaskCoordinator] SubTask heartbeat:`, JSON.stringify(message.params));
    } else if (method === 'orchestration.result') {
      const raw = message.params as Record<string, unknown>;
      const taskId = raw.taskId as string;
      const pending = this.orchestrationPending.get(taskId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.orchestrationPending.delete(taskId);
        try {
          const result = OrchestrationResultSchema.parse(raw);
          pending.resolve(result);
        } catch (err) {
          pending.reject(new Error(`Invalid orchestration result: ${err}`));
        }
      }
    }
  }
}
