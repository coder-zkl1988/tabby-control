/**
 * tabby-control — Tabby plugin entry point
 *
 * Starts a WebSocket server for phone connections (on wsPort)
 * and registers device control tools via the Tabby plugin API.
 */

import { createServer, type Server as HTTPServer } from 'http';
import { WsServer, DeviceRegistry } from './ws-server.js';
import { TaskCoordinator } from './task-coordinator.js';
import { MqttBroker } from './mqtt-broker.js';
import { MqttPhoneProxy } from './mqtt-phone-proxy.js';
import { BridgeClient } from './bridge.js';
import { Orchestrator } from './orchestrator.js';
import type { DeviceBridge, TaskResult, SubTaskResult, SubTaskExecuteParams, OrchestrationResult, ResumeParams, TaskStartParams, TaskEndParams } from './protocol.js';
import {
  createDeviceListTool,
  createExecuteTaskTool,
  createExecuteTaskAllTool,
  createExecuteBatchTool,
  createCancelTaskTool,
  createGetStatusTool,
  createExecuteSkillTool,
} from './tools.js';

// ─── Config ──────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  mqttPort: 18883,
  rpcPort: 18801,
};

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

  async executeTask(deviceId: string, task: string, timeoutMs = 300_000, guidance?: string, sessionId?: string, maxSteps?: number, allowedActions?: string[], allowedApps?: string[]): Promise<TaskResult> {
    return this.coordinator.executeTask(deviceId, task, timeoutMs, guidance, sessionId, maxSteps, allowedActions, allowedApps);
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

  async cancelTask(deviceId: string, taskId: string): Promise<void> {
    this.coordinator.cancelTask(deviceId, taskId);
  }

  async getStatus(deviceId: string) {
    return this.coordinator.getDeviceStatus(deviceId);
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

function startHttpServer(
  port: number,
  coordinator: TaskCoordinator,
  bridge: InProcessBridge,
  _notifier: (channel: string, data: unknown) => void,
  logger: TabbyLogger,
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
              );
              break;
            case 'device_execute_task_all':
              result = Object.fromEntries(
                await coordinator.executeTaskAll(params.task as string, params.timeoutMs as number ?? 300_000),
              );
              break;
            case 'device_execute_batch':
              result = Object.fromEntries(
                await coordinator.executeBatch(params.tasks as Array<{ deviceId: string; task: string }>, params.timeoutMs as number ?? 300_000),
              );
              break;
            case 'device_cancel_task':
              coordinator.cancelTask(params.deviceId as string, params.taskId as string);
              result = { cancelled: true };
              break;
            case 'device_get_status':
              result = coordinator.getDeviceStatus(params.deviceId as string);
              break;
            default:
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: { code: 'UNKNOWN_METHOD', message: `Unknown method: ${method}` } }));
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
            : 'INTERNAL_ERROR';
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
    logger.info(`[tabby-control] pluginConfig: ${JSON.stringify(pluginConfig)}`);
    const config = {
      wsPort: typeof pluginConfig.wsPort === 'number' ? pluginConfig.wsPort : 18790,
      mqttPort: typeof pluginConfig.mqttPort === 'number' ? pluginConfig.mqttPort : DEFAULT_CONFIG.mqttPort,
      rpcPort: typeof pluginConfig.rpcPort === 'number' ? pluginConfig.rpcPort : DEFAULT_CONFIG.rpcPort,
    };

    const ipcNotifier = (channel: string, data: unknown) => {
      logger.debug(`[tabby-control] IPC: ${channel}`);
    };

    const wsServer = new WsServer(config.wsPort, ipcNotifier);

    const mqttRegistry = wsServer.getRegistry();
    const mqttBroker = new MqttBroker(config.mqttPort, mqttRegistry);
    void mqttBroker.start().then(() => {
      logger.info(`[tabby-control] MQTT broker on mqtt://0.0.0.0:${config.mqttPort} (tcp+ws)`);
    });

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
      async executeTask(deviceId: string, task: string, timeoutMs?: number, guidance?: string, sessionId?: string, maxSteps?: number, allowedActions?: string[], allowedApps?: string[]): Promise<TaskResult> {
        return (await this._get()).executeTask(deviceId, task, timeoutMs, guidance, sessionId, maxSteps, allowedActions, allowedApps);
      }
      async executeTaskAll(task: string, timeoutMs?: number) { return (await this._get()).executeTaskAll(task, timeoutMs); }
      async executeBatch(tasks: Array<{ deviceId: string; task: string }>, timeoutMs?: number) { return (await this._get()).executeBatch(tasks, timeoutMs); }
      async cancelTask(deviceId: string, taskId: string) { return (await this._get()).cancelTask(deviceId, taskId); }
      async getStatus(deviceId: string) { return (await this._get()).getStatus(deviceId); }
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

        // MQTT proxy: bridge MQTT messages into coordinator/registry
        new MqttPhoneProxy(mqttBroker, wsServer.getRegistry(), coordinator.handleTaskMessage.bind(coordinator), ipcNotifier);

        const inProcess = new InProcessBridge(coordinator, wsServer.getRegistry(), ipcNotifier);
        startHttpServer(config.rpcPort, coordinator, inProcess, ipcNotifier, logger);
        logger.info(`[tabby-control] MQTT on mqtt://0.0.0.0:${config.mqttPort}, WebSocket on ws://0.0.0.0:${config.wsPort}/phone`);
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
    api.registerTool(makeTool(createCancelTaskTool));
    api.registerTool(makeTool(createGetStatusTool));
    api.registerTool(() => {
      if (!_orchestrator) return null;
      const tool = createExecuteSkillTool(_orchestrator, wsServer.getRegistry()) as TabbyTool;
      tool.isAvailable = () => true;
      return tool;
    });

    logger.info('[tabby-control] registered 7 device control tools (lazy bridge)');

    // Start server in background
    httpServer.listen(config.wsPort, '0.0.0.0', () => {
      logger.info(`[tabby-control] WebSocket server listening on ws://0.0.0.0:${config.wsPort}/phone`);
    });
  },
};
