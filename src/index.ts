/**
 * tabby-control — Tabby plugin entry point
 *
 * Starts a WebSocket server for phone connections (on wsPort)
 * and registers device control tools via the Tabby plugin API.
 */

import { createServer, type Server as HTTPServer } from 'http';
import { WsServer } from './ws-server.js';
import { TaskCoordinator } from './task-coordinator.js';

import type { TaskResult } from './protocol.js';
import {
  createDeviceListTool,
  createExecuteTaskTool,
  createExecuteTaskAllTool,
  createExecuteBatchTool,
  createCancelTaskTool,
  createGetStatusTool,
} from './tools.js';

// ─── Config ──────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  wsPort: 18800,
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

          switch (method) {
            case 'device.list':
              result = await bridge.listDevices();
              break;
            case 'device.execute_task':
              result = await coordinator.executeTask(
                params.deviceId as string,
                params.task as string,
                params.timeoutMs as number ?? 300_000,
              );
              break;
            case 'device.execute_task_all':
              result = Object.fromEntries(
                await coordinator.executeTaskAll(params.task as string, params.timeoutMs as number ?? 300_000),
              );
              break;
            case 'device.execute_batch':
              result = Object.fromEntries(
                await coordinator.executeBatch(params.tasks as Array<{ deviceId: string; task: string }>, params.timeoutMs as number ?? 300_000),
              );
              break;
            case 'device.cancel_task':
              coordinator.cancelTask(params.deviceId as string, params.taskId as string);
              result = { cancelled: true };
              break;
            case 'device.get_status':
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
      wsPort: typeof pluginConfig.wsPort === 'number' ? pluginConfig.wsPort : DEFAULT_CONFIG.wsPort,
      rpcPort: typeof pluginConfig.rpcPort === 'number' ? pluginConfig.rpcPort : DEFAULT_CONFIG.rpcPort,
    };

    const ipcNotifier = (channel: string, data: unknown) => {
      logger.debug(`[tabby-control] IPC: ${channel}`);
    };

    const wsServer = new WsServer(config.wsPort, ipcNotifier);

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

    // Tabby may load plugins through both [gateway] and [plugins]
    // registries across different workers.  When the port is already
    // bound, skip the rest of initialisation — the first worker's
    // registry already has the live device state and tools.
    let portBound = false;
    httpServer.listen(config.wsPort, '0.0.0.0', () => {
      portBound = true;
      logger.info(`[tabby-control] WebSocket server listening on ws://0.0.0.0:${config.wsPort}/phone`);
    });
    httpServer.on('error', (err) => {
      logger.warn(`[tabby-control] port ${config.wsPort} unavailable (${(err as Error & { code?: string }).code ?? (err as Error).message}) — skipping duplicate initialisation`);
    });

    // listen() is async; if the port is already in use the callback
    // never fires.  Wait a tick for the result.
    const initDone = new Promise<boolean>((resolve) => {
      httpServer.on('listening', () => resolve(true));
      httpServer.on('error', () => resolve(false));
      // also catch pre-listen errors
    });

    initDone.then((ok) => {
      if (!ok) {
        logger.warn('[tabby-control] port unavailable — tools not registered (already loaded by another worker)');
        return;
      }

      const coordinator = new TaskCoordinator(wsServer, ipcNotifier);

      wsServer.setTaskMessageHandler(coordinator.handleTaskMessage.bind(coordinator));

      wsServer.setMirrorHandler({
        onClick: (deviceId, params) => {
          logger.debug(`[tabby-control] mirror click ${deviceId}: ${JSON.stringify(params)}`);
        },
        onSwipe: (deviceId, params) => {
          logger.debug(`[tabby-control] mirror swipe ${deviceId}: ${JSON.stringify(params)}`);
        },
        onText: (deviceId, params) => {
          logger.debug(`[tabby-control] mirror text ${deviceId}: ${JSON.stringify(params)}`);
        },
        onKey: (deviceId, params) => {
          logger.debug(`[tabby-control] mirror key ${deviceId}: ${JSON.stringify(params)}`);
        },
      });

      const bridge = new InProcessBridge(coordinator, wsServer.getRegistry(), ipcNotifier);

      startHttpServer(config.rpcPort, coordinator, bridge, ipcNotifier, logger);

      function makeTool(factory: (bridge: InProcessBridge) => TabbyTool) {
        return (): TabbyTool => {
          const tool = factory(bridge);
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

      logger.info(
        `[tabby-control] registered 6 device control tools. ` +
        `WebSocket on ws://0.0.0.0:${config.wsPort}/phone, Mirror on ws://0.0.0.0:${config.wsPort}/mirror`,
      );
    });
  },
};
