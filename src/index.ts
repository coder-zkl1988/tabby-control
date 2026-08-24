/**
 * tabby-control — Tabby plugin entry point
 *
 * Starts a WebSocket server for phone connections (on wsPort)
 * and registers device control tools via the Tabby plugin API.
 */

import { createServer, type Server as HTTPServer } from 'http';
import { readFileSync } from 'fs';
import { WsServer, type VlmCredential } from './ws-server.js';
import { TaskCoordinator } from './task-coordinator.js';
import { BridgeClient } from './bridge.js';
import { Orchestrator } from './orchestrator.js';
import type { DeviceBridge, TaskResult, SubTaskResult, SubTaskExecuteParams, OrchestrationResult, ResumeParams, TaskStartParams, TaskEndParams, CachedTaskResult, TaskResultQuery, TaskPolicy } from './protocol.js';
import {
  createDeviceListTool,
  createExecuteTaskTool,
  createExecuteTaskAllTool,
  createExecuteBatchTool,
  createGetTaskResultsTool,
  createCancelTaskTool,
  createGetStatusTool,
  createExecuteSkillTool,
  createDispatchTasksTool,
  createJobStatusTool,
  createCancelJobTool,
} from './tools.js';

// ─── Config ──────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  rpcPort: 18801,
};

// ─── Build provenance ────────────────────────────────────────────────────────

/**
 * Read the build stamp written by `scripts/build-nexu.mjs` (version + git sha +
 * build time) so the running plugin announces exactly which build it is on
 * register. Version alone is ambiguous — the same version can be rebuilt with
 * different code, which is how a stale plugin shipped undetected. Falls back to
 * package.json version (plain `npm run build` / dev) when the stamp is absent.
 */
function readBuildInfo(): { version: string; gitSha: string; builtAt: string } {
  try {
    const raw = readFileSync(new URL('./build-info.json', import.meta.url), 'utf8');
    const info = JSON.parse(raw) as Partial<{
      version: string;
      gitSha: string;
      builtAt: string;
    }>;
    return {
      version: String(info.version ?? 'unknown'),
      gitSha: String(info.gitSha ?? 'unknown'),
      builtAt: String(info.builtAt ?? 'unknown'),
    };
  } catch {
    try {
      const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
      const pkg = JSON.parse(raw) as { version?: string };
      return { version: String(pkg.version ?? 'unknown'), gitSha: 'dev', builtAt: 'dev' };
    } catch {
      return { version: 'unknown', gitSha: 'unknown', builtAt: 'unknown' };
    }
  }
}

const BUILD_INFO = readBuildInfo();

// ─── Tabby plugin API types ────────────────────────────────────────────────────

interface TabbyLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

interface TabbyTool {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  isAvailable?: () => boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute(...args: any[]): Promise<TabbyToolResult>;
}

interface TabbyToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

interface TabbyPluginApi {
  logger: TabbyLogger;
  sessionKey?: string;
  config?: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
  registerTool(factory: (ctx: { sessionKey?: string }) => TabbyTool | null): void;
}

// ─── In-process bridge ──────────────────────────────────────────────────────

class InProcessBridge {
  constructor(
    private coordinator: TaskCoordinator,
    private registry: ReturnType<WsServer['getRegistry']>,
    private ipcNotifier: (channel: string, data: unknown) => void,
  ) {}

  async ping(): Promise<boolean> {
    return true;
  }

  async listDevices() {
    return this.registry.list();
  }

  async executeTask(deviceId: string, task: string, timeoutMs = 300_000, guidance?: string, sessionId?: string, maxSteps?: number, allowedActions?: string[], allowedApps?: string[], taskPolicy?: TaskPolicy): Promise<TaskResult> {
    return this.coordinator.executeTask(deviceId, task, timeoutMs, guidance, sessionId, maxSteps, allowedActions, allowedApps, taskPolicy);
  }

  async executeTaskAll(task: string, timeoutMs = 300_000) {
    const result = await this.coordinator.executeTaskAll(task, timeoutMs);
    return Object.fromEntries(result);
  }

  async executeBatch(
    tasks: Array<{ deviceId: string; task: string }>,
    timeoutMs = 300_000,
  ) {
    const result = await this.coordinator.executeBatch(tasks, timeoutMs);
    return Object.fromEntries(result);
  }

  async executeBatchBounded(
    tasks: Array<{ deviceId: string; task: string; maxSteps?: number }>,
    timeoutMs = 300_000,
    softDeadlineMs = 240_000,
  ) {
    const r = await this.coordinator.executeBatchBounded(tasks, timeoutMs, softDeadlineMs);
    return { ...r, results: Object.fromEntries(r.results) };
  }

  async dispatchTasks(tasks: Array<{ deviceId: string; task: string; maxSteps?: number }>, timeoutMs = 300_000) {
    return this.coordinator.dispatchTasks(tasks, timeoutMs);
  }

  async getJobStatus(jobId: string, opts?: { includeResults?: boolean; offset?: number; limit?: number }) {
    return this.coordinator.getJobStatus(jobId, opts);
  }

  async cancelJob(jobId: string) {
    return this.coordinator.cancelJob(jobId);
  }

  async getTaskResults(query: TaskResultQuery): Promise<CachedTaskResult[]> {
    if (query.taskId) {
      const entry = this.coordinator.getTaskResult(query.taskId);
      return entry ? [entry] : [];
    }
    return this.coordinator.getRecentTaskResults(query.deviceId, query.limit);
  }

  async cancelTask(deviceId: string, taskId: string): Promise<void> {
    this.coordinator.cancelTask(deviceId, taskId);
  }

  async getStatus(deviceId: string) {
    return this.coordinator.getDeviceStatus(deviceId);
  }

  async getTaskProgress(deviceId: string) {
    return this.coordinator.getTaskProgress(deviceId);
  }

  async executeSubTask(deviceId: string, params: SubTaskExecuteParams, timeoutMs?: number): Promise<SubTaskResult> {
    return this.coordinator.executeSubTask(deviceId, params, timeoutMs);
  }

  async resumeOrchestration(deviceId: string, params: ResumeParams): Promise<OrchestrationResult> {
    return this.coordinator.resumeOrchestration(deviceId, params);
  }

  async sendTaskStart(deviceId: string, params: TaskStartParams): Promise<void> {
    return this.coordinator.sendTaskStart(deviceId, params);
  }

  async sendTaskEnd(deviceId: string, params: TaskEndParams): Promise<void> {
    return this.coordinator.sendTaskEnd(deviceId, params);
  }
}

// ─── HTTP RPC server ───────────────────────────────────────────────────────────

export function startHttpServer(
  port: number,
  coordinator: TaskCoordinator,
  bridge: InProcessBridge,
  _notifier: (channel: string, data: unknown) => void,
  logger: TabbyLogger,
  setVlmCredential: (cred: VlmCredential | null) => void,
  setTelemetryConsent: (consent: boolean) => void,
): HTTPServer {
  const server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://localhost:${port}`);

    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', port }));
      return;
    }

    if (url.pathname === '/devices' && req.method === 'GET') {
      const devices = await bridge.listDevices();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ devices }));
      return;
    }

    if (url.pathname === '/rpc' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const { method, params } = JSON.parse(body) as { method: string; params: Record<string, unknown> };
          let result: unknown;

          // Accept both dot notation (device.execute_task) and underscore notation (device_execute_task)
          const normalizedMethod = method.replace('.', '_');
          switch (normalizedMethod) {
            case 'device_list':
              result = await bridge.listDevices();
              break;
            case 'device_execute_task':
              result = await coordinator.executeTask(
                params.deviceId as string,
                params.task as string,
                params.timeoutMs as number ?? 300_000,
                params.guidance as string | undefined,
                params.sessionId as string | undefined,
                params.maxSteps as number | undefined,
                params.allowedActions as string[] | undefined,
                params.allowedApps as string[] | undefined,
                params.taskPolicy as TaskPolicy | undefined,
              );
              break;
            case 'device_execute_task_all': {
              result = Object.fromEntries(
                await coordinator.executeTaskAll(params.task as string, params.timeoutMs as number ?? 300_000),
              );
              break;
            }
            case 'device_execute_batch_bounded': {
              const tasks = params.tasks as Array<{ deviceId: string; task: string; maxSteps?: number }>;
              const r = await coordinator.executeBatchBounded(
                tasks,
                params.timeoutMs as number ?? 300_000,
                params.softDeadlineMs as number ?? 240_000,
              );
              result = { ...r, results: Object.fromEntries(r.results) };
              break;
            }
            case 'device_dispatch_tasks': {
              const tasks = params.tasks as Array<{ deviceId: string; task: string; maxSteps?: number }>;
              result = coordinator.dispatchTasks(tasks, params.timeoutMs as number ?? 300_000);
              break;
            }
            case 'device_job_status':
              result = coordinator.getJobStatus(params.jobId as string, {
                includeResults: params.includeResults as boolean | undefined,
                offset: params.offset as number | undefined,
                limit: params.limit as number | undefined,
              });
              break;
            case 'device_cancel_job':
              result = coordinator.cancelJob(params.jobId as string);
              break;
            case 'device_execute_batch': {
              const tasks = params.tasks as Array<{ deviceId: string; task: string }>;
              result = Object.fromEntries(
                await coordinator.executeBatch(tasks, params.timeoutMs as number ?? 300_000),
              );
              break;
            }
            case 'device_get_task_results':
              result = await bridge.getTaskResults({
                taskId: params.taskId as string | undefined,
                deviceId: params.deviceId as string | undefined,
                limit: params.limit as number | undefined,
              });
              break;
            case 'device_cancel_task':
              coordinator.cancelTask(
                params.deviceId as string,
                (params.taskId as string | undefined) ?? 'current',
              );
              result = { cancelled: true };
              break;
            case 'device_get_status':
              result = coordinator.getDeviceStatus(params.deviceId as string);
              break;
            case 'device_set_vlm_credential': {
              // nexu pushes the signed-in user's gateway credential here on
              // login/logout/refresh; null/missing clears it (phone falls back
              // to local VLM settings). Applied to phones on their next connect.
              const cred = params.credential as VlmCredential | null | undefined;
              if (cred && cred.apiUrl && cred.apiKey && cred.model) {
                setVlmCredential({
                  apiUrl: cred.apiUrl,
                  apiKey: cred.apiKey,
                  model: cred.model,
                  reasoningEffort: cred.reasoningEffort,
                });
              } else {
                setVlmCredential(null);
              }
              result = { ok: true };
              break;
            }
            case 'device_set_telemetry_consent': {
              // nexu pushes the desktop "crash reports" consent here on toggle
              // change/startup; phones cache it locally to gate Sentry reporting.
              const enabled = params.enabled;
              if (typeof enabled !== 'boolean') {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { code: 'INVALID_PARAMS', message: 'enabled must be a boolean' } }));
                return;
              }
              setTelemetryConsent(enabled);
              result = { ok: true };
              break;
            }
            case 'device_push_media':
              result = await coordinator.pushMedia(
                params.deviceId as string,
                {
                  filename: params.filename as string,
                  mimeType: params.mimeType as string,
                  dataBase64: params.dataBase64 as string,
                },
                (params.timeoutMs as number) ?? 30_000,
              );
              break;
            default:
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: { code: 'UNKNOWN_METHOD', message: `Unknown method: ${method}` } }));
              return;
          }

          if (res.destroyed || res.writableEnded) {
            logger.warn('[tabby-control] RPC caller disconnected before response; task result remains available for recovery');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ result }));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const code = msg.includes('NOT_FOUND') ? 'DEVICE_NOT_FOUND'
            : msg.includes('TIMEOUT') ? 'TIMEOUT'
            : msg.includes('OFFLINE') ? 'DEVICE_OFFLINE'
            : msg.includes('BUSY') ? 'TASK_ALREADY_RUNNING'
            : msg.includes('CANCELLED') ? 'CANCELLED'
            : 'INTERNAL_ERROR';
          if (res.destroyed || res.writableEnded) {
            logger.warn('[tabby-control] RPC caller disconnected before response; task state remains owned by the coordinator');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code, message: msg } }));
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }));
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info(`[tabby-control] HTTP RPC server listening on http://0.0.0.0:${port}`);
  });

  return server;
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default {
  id: 'tabby-control',
  name: 'TabbyControl',
  description:
    'Standalone Android device control via WebSocket. No Tabby desktop app required.',

  configSchema: {
    parse(value: unknown): Record<string, unknown> {
      return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    },
  },

  register(api: TabbyPluginApi): void {
    const pluginConfig = api.pluginConfig ?? {};
    const logger = api.logger;
    logger.info(
      `[tabby-control] v${BUILD_INFO.version} (build ${BUILD_INFO.gitSha}, built ${BUILD_INFO.builtAt})`,
    );
    logger.info(`[tabby-control] pluginConfig: ${JSON.stringify(pluginConfig)}`);
    const config = {
      wsPort: typeof pluginConfig.wsPort === 'number' ? pluginConfig.wsPort : 18790,
      rpcPort: typeof pluginConfig.rpcPort === 'number' ? pluginConfig.rpcPort : DEFAULT_CONFIG.rpcPort,
    };

    const ipcNotifier = (channel: string) => {
      logger.debug(`[tabby-control] IPC: ${channel}`);
    };

    const wsServer = new WsServer(config.wsPort, ipcNotifier);

    // VLM 网关凭证：由 nexu 在登录态变化/启动时通过 RPC(device_set_vlm_credential)
    // 推送，缓存在此闭包；手机连接时 WsServer 读取并随 connected 下发。
    // null = 未登录/未推送 → 手机回退本地 VLM 设置。
    let currentVlmCredential: VlmCredential | null = null;
    const setVlmCredential = (cred: VlmCredential | null) => {
      currentVlmCredential = cred;
      logger.info(`[tabby-control] VLM credential ${cred ? `set (model=${cred.model})` : 'cleared'}`);
      // The connect-time handshake only delivers the credential to phones that
      // connect AFTER this point. Push it to already-connected devices too so a
      // credential that arrives post-connect (e.g. after a gateway restart)
      // still reaches them without requiring a reconnect.
      const pushed = wsServer.broadcastConnectedState();
      if (pushed > 0) {
        logger.info(`[tabby-control] VLM credential pushed to ${pushed} connected device(s)`);
      }
    };
    wsServer.setVlmCredentialProvider(() => currentVlmCredential);

    // 遥测同意态（桌面「崩溃报告」开关）：由 nexu 在开关变化/启动时通过
    // RPC(device_set_telemetry_consent) 推送，缓存在此闭包；手机连接时随
    // connected 下发，用于门控手机端 Sentry 上报。null = 未推送 → 不下发
    // 该字段，手机沿用本地缓存的同意态。
    let currentTelemetryConsent: boolean | null = null;
    const setTelemetryConsent = (consent: boolean) => {
      currentTelemetryConsent = consent;
      logger.info(`[tabby-control] Telemetry consent ${consent ? 'enabled' : 'disabled'}`);
      const pushed = wsServer.broadcastConnectedState();
      if (pushed > 0) {
        logger.info(`[tabby-control] Telemetry consent pushed to ${pushed} connected device(s)`);
      }
    };
    wsServer.setTelemetryConsentProvider(() => currentTelemetryConsent);

    const httpServer = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', port: config.wsPort }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    wsServer.attachToServer(httpServer);

    // Register tools synchronously so OpenClaw's descriptor cache
    // captures them (snapshot happens right after register() returns).
    // The bridge resolves lazily on first use — in-process when the
    // port is available (gateway worker), or HTTP to port 18801 when
    // it's already bound (agent worker hitting EADDRINUSE).

    class LazyBridge implements DeviceBridge {
      private _bridge: DeviceBridge | null = null;
      private _pending: Promise<DeviceBridge>;

      constructor(promise: Promise<DeviceBridge>) { this._pending = promise; }
      private async _get(): Promise<DeviceBridge> {
        if (!this._bridge) this._bridge = await this._pending;
        return this._bridge;
      }
      async ping() { return (await this._get()).ping(); }
      async listDevices() { return (await this._get()).listDevices(); }
      async executeTask(deviceId: string, task: string, timeoutMs?: number, guidance?: string, sessionId?: string, maxSteps?: number, allowedActions?: string[], allowedApps?: string[], taskPolicy?: TaskPolicy): Promise<TaskResult> {
        return (await this._get()).executeTask(deviceId, task, timeoutMs, guidance, sessionId, maxSteps, allowedActions, allowedApps, taskPolicy);
      }
      async executeTaskAll(task: string, timeoutMs?: number) { return (await this._get()).executeTaskAll(task, timeoutMs); }
      async executeBatch(tasks: Array<{ deviceId: string; task: string }>, timeoutMs?: number) { return (await this._get()).executeBatch(tasks, timeoutMs); }
      async executeBatchBounded(tasks: Array<{ deviceId: string; task: string; maxSteps?: number }>, timeoutMs?: number, softDeadlineMs?: number) { return (await this._get()).executeBatchBounded(tasks, timeoutMs, softDeadlineMs); }
      async dispatchTasks(tasks: Array<{ deviceId: string; task: string; maxSteps?: number }>, timeoutMs?: number) { return (await this._get()).dispatchTasks(tasks, timeoutMs); }
      async getJobStatus(jobId: string, opts?: { includeResults?: boolean; offset?: number; limit?: number }) { return (await this._get()).getJobStatus(jobId, opts); }
      async cancelJob(jobId: string) { return (await this._get()).cancelJob(jobId); }
      async getTaskResults(query: TaskResultQuery) { return (await this._get()).getTaskResults(query); }
      async cancelTask(deviceId: string, taskId: string) { return (await this._get()).cancelTask(deviceId, taskId); }
      async getStatus(deviceId: string) { return (await this._get()).getStatus(deviceId); }
      async getTaskProgress(deviceId: string) {
        const bridge = await this._get();
        return bridge.getTaskProgress ? bridge.getTaskProgress(deviceId) : null;
      }
      async executeSubTask(deviceId: string, params: SubTaskExecuteParams, timeoutMs?: number) {
        return (await this._get()).executeSubTask(deviceId, params, timeoutMs);
      }
      async resumeOrchestration(deviceId: string, params: ResumeParams) {
        return (await this._get()).resumeOrchestration(deviceId, params);
      }
      async sendTaskStart(deviceId: string, params: TaskStartParams) {
        return (await this._get()).sendTaskStart(deviceId, params);
      }
      async sendTaskEnd(deviceId: string, params: TaskEndParams) {
        return (await this._get()).sendTaskEnd(deviceId, params);
      }
    }

    let _orchestrator: Orchestrator | null = null;

    const bridgePromise = new Promise<DeviceBridge>((resolve) => {
      httpServer.once('listening', () => {
        // Gateway worker: port available → full setup
        const coordinator = new TaskCoordinator(wsServer, ipcNotifier);
        wsServer.setTaskMessageHandler(coordinator.handleTaskMessage.bind(coordinator));
        _orchestrator = new Orchestrator(coordinator);
        wsServer.setMirrorHandler({
          onClick: (deviceId: string, params: Record<string, unknown>) => {
            logger.debug(`[tabby-control] mirror click ${deviceId}: ${JSON.stringify(params)}`);
          },
          onSwipe: (deviceId: string, params: Record<string, unknown>) => {
            logger.debug(`[tabby-control] mirror swipe ${deviceId}: ${JSON.stringify(params)}`);
          },
          onText: (deviceId: string, params: Record<string, unknown>) => {
            logger.debug(`[tabby-control] mirror text ${deviceId}: ${JSON.stringify(params)}`);
          },
          onKey: (deviceId: string, params: Record<string, unknown>) => {
            logger.debug(`[tabby-control] mirror key ${deviceId}: ${JSON.stringify(params)}`);
          },
        });

        const inProcess = new InProcessBridge(coordinator, wsServer.getRegistry(), ipcNotifier);
        startHttpServer(config.rpcPort, coordinator, inProcess, ipcNotifier, logger, setVlmCredential, setTelemetryConsent);
        logger.info(`[tabby-control] WebSocket on ws://0.0.0.0:${config.wsPort}/phone`);
        resolve(inProcess);
      });
      httpServer.once('error', () => {
        // Agent / other worker: port unavailable → HTTP bridge
        logger.warn(`[tabby-control] port ${config.wsPort} unavailable (EADDRINUSE) — using HTTP bridge`);
        resolve(new BridgeClient(config.rpcPort));
      });
    });

    const lazyBridge = new LazyBridge(bridgePromise);

    function makeTool(factory: (bridge: DeviceBridge) => TabbyTool) {
      return (): TabbyTool => {
        const tool = factory(lazyBridge);
        tool.isAvailable = () => true;
        return tool;
      };
    }

    api.registerTool(makeTool(createDeviceListTool));
    api.registerTool(makeTool(createExecuteTaskTool));
    api.registerTool(makeTool(createExecuteTaskAllTool));
    api.registerTool(makeTool(createExecuteBatchTool));
    api.registerTool(makeTool(createDispatchTasksTool));
    api.registerTool(makeTool(createJobStatusTool));
    api.registerTool(makeTool(createCancelJobTool));
    api.registerTool(makeTool(createGetTaskResultsTool));
    api.registerTool(makeTool(createCancelTaskTool));
    api.registerTool(makeTool(createGetStatusTool));
    api.registerTool(() => {
      if (!_orchestrator) return null;
      const tool = createExecuteSkillTool(_orchestrator, wsServer.getRegistry()) as TabbyTool;
      tool.isAvailable = () => true;
      return tool;
    });

    logger.info('[tabby-control] registered 8 device control tool factories (lazy bridge)');

    // Start server in background
    httpServer.listen(config.wsPort, '0.0.0.0', () => {
      logger.info(`[tabby-control] WebSocket server listening on ws://0.0.0.0:${config.wsPort}/phone`);
    });
  },
};
