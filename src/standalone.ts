#!/usr/bin/env node
/**
 * tabby-control — Standalone device control service
 *
 * Starts WebSocket server (phone connections) + HTTP RPC server (controller queries)
 * without requiring OpenClaw plugin infrastructure.
 *
 * Usage:
 *   node dist/standalone.js              # defaults: wsPort=18800 rpcPort=18801
 *   node dist/standalone.js --ws-port 19000 --rpc-port 19001
 */

import { createServer } from 'http';
import { WsServer } from './ws-server.js';
import { TaskCoordinator } from './task-coordinator.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2).replace(/-/g, '');
      opts[key] = args[i + 1] ?? '';
      i++;
    }
  }
  return {
    wsPort: parseInt(opts.wsport ?? '18800', 10),
    rpcPort: parseInt(opts.rpcport ?? '18801', 10),
  };
}

function log(level: string, msg: string) {
  // stderr so stdout stays clean for MCP mode
  process.stderr.write(`[tabby-control] ${level} ${msg}\n`);
}

async function main() {
  const { wsPort, rpcPort } = parseArgs();
  const ipcNotifier = (_channel: string, _data: unknown) => {};

  // ── Start WebSocket server for phone connections ──
  const wsServer = new WsServer(wsPort, ipcNotifier);
  const coordinator = new TaskCoordinator(wsServer, ipcNotifier);
  wsServer.setTaskMessageHandler(coordinator.handleTaskMessage.bind(coordinator));

  // Listen on the WebSocket port
  const phoneServer = createServer();
  wsServer.attachToServer(phoneServer);
  phoneServer.listen(wsPort, '0.0.0.0', () => {
    log('info', `WebSocket server listening on ws://0.0.0.0:${wsPort}/phone`);
  });

  // ── Start HTTP RPC server for controller/OpenClaw queries ──
  const rpcServer = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url ?? '/', `http://localhost:${rpcPort}`);

    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', wsPort, rpcPort }));
      return;
    }

    if (url.pathname === '/devices' && req.method === 'GET') {
      const devices = wsServer.getRegistry().list();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ devices }));
      return;
    }

    if (url.pathname === '/rpc' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const { method, params } = JSON.parse(body) as { method: string; params: Record<string, unknown> };
          let result: unknown;

          switch (method) {
            case 'device.list':
              result = wsServer.getRegistry().list();
              break;
            case 'device.get_status':
              result = coordinator.getDeviceStatus(params.deviceId as string);
              break;
            case 'device.execute_task':
              result = await coordinator.executeTask(
                params.deviceId as string,
                params.task as string,
                (params.timeoutMs as number) ?? 300_000,
              );
              break;
            case 'device.cancel_task':
              coordinator.cancelTask(params.deviceId as string, params.taskId as string);
              result = { cancelled: true };
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
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: msg } }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  rpcServer.listen(rpcPort, '0.0.0.0', () => {
    log('info', `RPC server listening on http://0.0.0.0:${rpcPort}`);
  });

  log('info', `tabby-control standalone started (wsPort=${wsPort}, rpcPort=${rpcPort})`);

  // Graceful shutdown
  const shutdown = () => {
    log('info', 'shutting down...');
    wsServer.stop();
    phoneServer.close();
    rpcServer.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log('error', `fatal: ${err.message}`);
  process.exit(1);
});
