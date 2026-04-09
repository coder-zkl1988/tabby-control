/**
 * lobster-device-control — OpenClaw plugin entry point
 *
 * Standalone mode: this plugin starts its own WebSocket server (phone connections)
 * and HTTP RPC bridge, without requiring the LobsterAI desktop app.
 *
 * Architecture:
 *   OpenClaw agent calls tool
 *   → direct in-process TaskRegistry / WsServer (no HTTP bridge needed)
 *   → tool returns result to agent
 *
 * Additionally starts:
 *   HTTP server on 18801 — REST RPC for OpenClaw tools
 *   WebSocket server on 18800 /phone — accepts phone connections
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
  httpPort: 18801,
};

// ─── OpenClaw plugin API types ─────────────────────────────────────────────────

interface OpenClawLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

interface OpenClawTool {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  isAvailable?: () => boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute(...args: any[]): Promise<OpenClawToolResult>;
}

interface OpenClawToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

interface OpenClawPluginApi {
  logger: OpenClawLogger;
  sessionKey?: string;
  registerTool(factory: (ctx: { sessionKey?: string }) => OpenClawTool | null): void;
}

// ─── In-process bridge (replaces HTTP RPC) ─────────────────────────────────────

/**
 * InProcessBridge mimics BridgeClient's interface but calls TaskCoordinator directly.
 * This avoids HTTP overhead and removes the dependency on an external bridge server.
 */
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

  async executeTask(deviceId: string, task: string, timeoutMs = 300_000): Promise<TaskResult> {
    return this.coordinator.executeTask(deviceId, task, timeoutMs);
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
  notifier: (channel: string, data: unknown) => void,
  logger: OpenClawLogger,
): HTTPServer {
  const server = createServer(async (req, res) => {
    // CORS headers for local dev
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://localhost:${port}`);

    // Health check
    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', port }));
      return;
    }

    // Token endpoint — no token required anymore
    if (url.pathname === '/pairing-token' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ token: null, message: 'no token required', port: DEFAULT_CONFIG.wsPort }));
      return;
    }

    // Device list
    if (url.pathname === '/devices' && req.method === 'GET') {
      const devices = await bridge.listDevices();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ devices }));
      return;
    }

    // RPC endpoint
    if (url.pathname === '/rpc' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const { method, params } = JSON.parse(body) as { method: string; params: Record<string, unknown> };
          let result: unknown;

          switch (method) {
            case 'device.list':
              result = await coordinator.executeTaskAll('', 1);
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
    logger.info(`[lobster-device-control] HTTP RPC server listening on http://0.0.0.0:${port}`);
  });

  return server;
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default {
  id: 'lobster-device-control',
  name: 'LobsterDeviceControl',
  description:
    'Standalone Android device control via WebSocket. No LobsterAI desktop app required.',

  configSchema: {
    parse(value: unknown): Record<string, unknown> {
      return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    },
  },

  register(api: OpenClawPluginApi): void {
    const config = { ...DEFAULT_CONFIG };
    const logger = api.logger;

    // ── IPC notifier (in-process, no Electron IPC) ─────────────────────────────
    const ipcNotifier = (channel: string, data: unknown) => {
      logger.debug(`[lobster-device-control] IPC: ${channel} ${JSON.stringify(data)}`);
    };

    // ── Start WebSocket server ────────────────────────────────────────────────
    const wsServer = new WsServer(config.wsPort, ipcNotifier);

    // Create HTTP server and attach WS upgrade handler
    const httpServer = createServer();
    wsServer.attachToServer(httpServer);

    // Start WS server
    httpServer.listen(config.wsPort, '0.0.0.0', () => {
      logger.info(
        `[lobster-device-control] WebSocket server listening on ws://0.0.0.0:${config.wsPort}/phone`,
      );
      logger.info(
        `[lobster-device-control] No authentication required — any device on the network can connect.`,
      );
    });

    // ── Start TaskCoordinator ──────────────────────────────────────────────────
    const coordinator = new TaskCoordinator(wsServer, ipcNotifier);

    // Wire task messages from phones → coordinator
    wsServer.setMirrorHandler({
      onClick: (deviceId, params) => {
        logger.debug(`[lobster-device-control] mirror click ${deviceId}: ${JSON.stringify(params)}`);
      },
      onSwipe: (deviceId, params) => {
        logger.debug(`[lobster-device-control] mirror swipe ${deviceId}: ${JSON.stringify(params)}`);
      },
      onText: (deviceId, params) => {
        logger.debug(`[lobster-device-control] mirror text ${deviceId}: ${JSON.stringify(params)}`);
      },
      onKey: (deviceId, params) => {
        logger.debug(`[lobster-device-control] mirror key ${deviceId}: ${JSON.stringify(params)}`);
      },
    });

    // ── In-process bridge (replaces HTTP bridge client) ───────────────────────
    const bridge = new InProcessBridge(coordinator, wsServer.getRegistry(), ipcNotifier);

    // ── Start HTTP RPC server ──────────────────────────────────────────────────
    startHttpServer(config.httpPort, coordinator, bridge, ipcNotifier, logger);

    // ── Register OpenClaw tools ───────────────────────────────────────────────
    function makeTool(factory: (bridge: InProcessBridge) => OpenClawTool) {
      return (): OpenClawTool => {
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
      `[lobster-device-control] registered 6 device control tools. ` +
      `WebSocket on ws://0.0.0.0:${config.wsPort}/phone`,
    );
    logger.info(
      `[lobster-device-control] HTTP RPC on http://0.0.0.0:${config.httpPort}`,
    );
  },
};
