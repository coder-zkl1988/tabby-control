#!/usr/bin/env node
/**
 * tabby-control — Standalone device control service (MQTT edition)
 *
 * Starts MQTT broker (phone + browser) + HTTP RPC server (controller queries).
 *
 * Usage:
 *   node dist/standalone.js                         # defaults: mqttPort=18883 rpcPort=18801
 *   node dist/standalone.js --mqtt-port 19083 --rpc-port 19001
 */

import { createServer } from 'http';
import { DeviceRegistry, WsServer } from './ws-server.js';
import { TaskCoordinator } from './task-coordinator.js';
import { Orchestrator } from './orchestrator.js';
import { MqttBroker } from './mqtt-broker.js';
import { MqttPhoneProxy } from './mqtt-phone-proxy.js';

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
    mqttPort: parseInt(opts.mqttport ?? '18883', 10),
    rpcPort: parseInt(opts.rpcport ?? '18801', 10),
  };
}

function log(level: string, msg: string) {
  process.stderr.write(`[tabby-control] ${level} ${msg}\n`);
}

async function main() {
  const { mqttPort, rpcPort } = parseArgs();
  const ipcNotifier = (_channel: string, _data: unknown) => {};

  // ── Device registry (shared) ──
  const registry = new DeviceRegistry();

  // ── Start MQTT broker ──
  const mqttBroker = new MqttBroker(mqttPort, registry);
  await mqttBroker.start();
  log('info', `MQTT broker listening on mqtt://0.0.0.0:${mqttPort} (tcp+ws)`);

  // ── WsServer shim (sendToDevice filled in after proxy creation) ──
  let proxy: MqttPhoneProxy;

  const wsServerShim = {
    getRegistry: () => registry,
    sendToDevice: (deviceId: string, msg: Record<string, unknown>) => {
      const channel = (msg as { channel?: string }).channel;
      if (channel === 'task') {
        const method = (msg as { method?: string }).method;
        const params = (msg as { params?: Record<string, unknown> }).params;
        if (method === 'agent.execute' && params && proxy) {
          proxy.publishTask(deviceId, params as never);
        } else if (method === 'agent.cancel' && params && proxy) {
          proxy.publishCancel(deviceId, (params as { taskId: string }).taskId);
        }
      }
    },
  };

  // ── Task coordinator ──
  const coordinator = new TaskCoordinator(
    wsServerShim as unknown as WsServer,
    ipcNotifier,
  );

  // ── Skill orchestration ──
  const orchestrator = new Orchestrator(coordinator);

  // ── MQTT phone proxy (bridges MQTT → registry/coordinator) ──
  proxy = new MqttPhoneProxy(
    mqttBroker,
    registry,
    coordinator.handleTaskMessage.bind(coordinator),
    ipcNotifier,
  );

  // ── Start HTTP RPC server ──
  const rpcServer = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url ?? '/', `http://localhost:${rpcPort}`);

    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', mqttPort, rpcPort }));
      return;
    }

    if (url.pathname === '/devices' && req.method === 'GET') {
      const devices = registry.list();
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

          // Accept both dot notation (device.execute_task) and underscore notation (device_execute_task)
          const normalizedMethod = method.replace('.', '_');
          switch (normalizedMethod) {
            case 'device_list':
              result = registry.list();
              break;
            case 'device_get_status':
              result = coordinator.getDeviceStatus(params.deviceId as string);
              break;
            case 'device_execute_task':
              result = await coordinator.executeTask(
                params.deviceId as string,
                params.task as string,
                (params.timeoutMs as number) ?? 300_000,
              );
              break;
            case 'device_cancel_task':
              coordinator.cancelTask(params.deviceId as string, params.taskId as string);
              result = { cancelled: true };
              break;
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
            case 'device_execute_skill': {
              const { deviceId, task, steps: rawSteps, handlers: rawHandlers, timeoutMs } = params as {
                deviceId: string; task: string;
                steps?: Array<{ name: string; type: string; action?: string; prompt?: string; maxSteps?: number; validation?: string }>;
                handlers?: Array<{ name: string; trigger: string; strategy: string; action?: string }>;
                timeoutMs?: number;
              };
              const steps = (rawSteps ?? []).map(s => ({
                name: s.name,
                type: s.type as 'deterministic' | 'flexible',
                action: s.action,
                prompt: s.prompt,
                maxSteps: s.maxSteps,
                validation: s.validation,
              }));
              const handlers = (rawHandlers ?? []).map(h => ({
                name: h.name,
                trigger: h.trigger,
                strategy: h.strategy as 'dismiss' | 'ignore' | 'report',
                action: h.action,
              }));
              result = await orchestrator.executeSkillTask(
                deviceId, task, steps, handlers, timeoutMs ?? 600_000,
              );
              break;
            }
            case 'device_resume_orchestration': {
              const { deviceId, taskId, subtaskId, confirmed } = params ?? {};
              if (!deviceId || !taskId || !subtaskId || confirmed === undefined) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { code: 'INVALID_PARAMS', message: 'deviceId, taskId, subtaskId, and confirmed are required' } }));
                return;
              }
              result = await orchestrator.resumeOrchestration(
                deviceId as string, taskId as string, subtaskId as string, confirmed as boolean,
              );
              break;
            }
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

    // Device QR config endpoint — phone fetches after scanning
    if (url.pathname === '/config' && req.method === 'GET') {
      const deviceId = url.searchParams.get('deviceId') ?? undefined;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ mqttPort, deviceId }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  rpcServer.listen(rpcPort, '0.0.0.0', () => {
    log('info', `RPC server listening on http://0.0.0.0:${rpcPort}`);
  });

  log('info', `tabby-control standalone started (mqttPort=${mqttPort}, rpcPort=${rpcPort})`);

  // Graceful shutdown
  const shutdown = async () => {
    log('info', 'shutting down...');
    await mqttBroker.stop();
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
