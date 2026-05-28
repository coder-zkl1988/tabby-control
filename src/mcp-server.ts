#!/usr/bin/env node
/**
 * tabby-control — MCP Server entry (Hermes integration)
 *
 * Starts all device control services (WebSocket + HTTP RPC) and exposes
 * device control tools via MCP stdio protocol for Hermes integration.
 *
 * Hermes ~/.hermes/config.yaml:
 *   mcp_servers:
 *     device-control:
 *       command: "node"
 *       args: ["path/to/tabby-control/dist/mcp-server.js"]
 *
 * Stdout = MCP protocol, Stderr = logs (Hermes MCP client reads stdout only)
 */

import { createServer } from 'http';
import { WsServer } from './ws-server.js';
import { TaskCoordinator } from './task-coordinator.js';
import { Orchestrator } from './orchestrator.js';
import type { DeviceBridge } from './protocol.js';

// ── Redirect console.log to stderr (stdout is MCP protocol) ──

const originalLog = console.log.bind(console);
console.log = (...args: unknown[]) => process.stderr.write(args.map(a => String(a)).join(' ') + '\n');
console.error = (...args: unknown[]) => process.stderr.write(args.map(a => String(a)).join(' ') + '\n');

function log(msg: string) {
  process.stderr.write(`[tabby-control] ${msg}\n`);
}

// ── Minimal MCP protocol implementation ──

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

class McpServer {
  private bridge: DeviceBridge;
  private orchestrator: Orchestrator | null;
  private initialized = false;
  private buffer = '';

  constructor(bridge: DeviceBridge, orchestrator?: Orchestrator) {
    this.bridge = bridge;
    this.orchestrator = orchestrator ?? null;
  }

  start() {
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => {
      this.buffer += chunk;
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          this.handleMessage(trimmed);
        }
      }
    });
    process.stdin.on('end', () => process.exit(0));
    process.stdin.resume();
  }

  private send(id: number | string | undefined, result: unknown) {
    const msg: JsonRpcMessage = { jsonrpc: "2.0", id, result };
    process.stdout.write(JSON.stringify(msg) + '\n');
  }

  private sendError(id: number | string | undefined, code: number, message: string) {
    const msg: JsonRpcMessage = { jsonrpc: "2.0", id, error: { code, message } };
    process.stdout.write(JSON.stringify(msg) + '\n');
  }

  private async handleMessage(raw: string) {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (!msg.method) return;
    const id = msg.id ?? crypto.randomUUID();
    const params = msg.params ?? {};

    try {
      switch (msg.method) {
        // ── MCP initialization ──
        case 'initialize': {
          this.initialized = true;
          // Respond with "initialized" notification per MCP spec
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            method: "initialized",
          }) + '\n');
          this.send(id, {
            protocolVersion: "2024-11-05",
            capabilities: {
              tools: {},
              prompts: {},
              resources: {},
            },
            serverInfo: { name: "tabby-control", version: "1.0.0" },
          });
          break;
        }

        // ── List tools ──
        case 'tools/list': {
          this.send(id, {
            tools: [
              {
                name: "device_list",
                description: "List all connected Android devices with their status, model, battery level, etc.",
                inputSchema: {
                  type: "object",
                  properties: {},
                  required: [],
                },
              },
              {
                name: "device_get_status",
                description: "Get detailed status of a specific device.",
                inputSchema: {
                  type: "object",
                  properties: {
                    deviceId: { type: "string", description: "Device ID from device_list" },
                  },
                  required: ["deviceId"],
                },
              },
              {
                name: "device_execute_task",
                description: "Send a natural language task to a connected device. The device runs its own autonomous loop (screenshot → AI → action → repeat) and returns the result. Send the COMPLETE task as one call — do NOT split into sub-steps.",
                inputSchema: {
                  type: "object",
                  properties: {
                    deviceId: { type: "string", description: "Device ID from device_list" },
                    task: { type: "string", description: "Natural language task (e.g. '打开微信给张三发消息：今晚吃饭吗')" },
                    timeoutMs: { type: "number", description: "Timeout in milliseconds", default: 300000 },
                  },
                  required: ["deviceId", "task"],
                },
              },
              {
                name: "device_cancel_task",
                description: "Cancel a running task on a device.",
                inputSchema: {
                  type: "object",
                  properties: {
                    deviceId: { type: "string", description: "Device ID" },
                    taskId: { type: "string", description: "Task ID to cancel" },
                  },
                  required: ["deviceId", "taskId"],
                },
              },
              {
                name: "device_execute_skill",
                description: "Execute a task using skill-based sub-task orchestration. Decomposes complex tasks into ≤3-step sub-tasks with skill hints. Falls back to device_execute_task if no skill is available. Supports resume flow (action='resume') for operations requiring user confirmation.",
                inputSchema: {
                  type: "object",
                  properties: {
                    deviceId: { type: "string", description: "Device ID from device_list" },
                    task: { type: "string", description: "Natural language task description" },
                    currentApp: { type: "string", description: "Current app package name (optional, uses device's current app if omitted)" },
                    timeout: { type: "number", description: "Timeout in milliseconds", default: 600000 },
                    action: { type: "string", description: "Action to perform. 'start' (default) begins a new orchestration. 'resume' resumes a paused orchestration after confirmation.", enum: ["start", "resume"] },
                    confirmed: { type: "boolean", description: "Only for action='resume'. true = proceed, false = cancel." },
                    subtaskId: { type: "string", description: "Only for action='resume'. The pendingSubTaskId from the needs_confirmation result." },
                    taskId: { type: "string", description: "Only for action='resume'. The original orchestration taskId." },
                  },
                  required: ["deviceId", "task"],
                },
              },
            ],
          });
          break;
        }

        // ── Call a tool ──
        case 'tools/call': {
          const name = params.name as string;
          const args = params.arguments as Record<string, unknown> ?? {};

          switch (name) {
            case 'device_list': {
              const devices = await this.bridge.listDevices();
              this.send(id, {
                content: [{ type: "text", text: JSON.stringify(devices, null, 2) }],
              });
              break;
            }
            case 'device_get_status': {
              const device = await this.bridge.getStatus(args.deviceId as string);
              this.send(id, {
                content: [{ type: "text", text: JSON.stringify(device, null, 2) }],
              });
              break;
            }
            case 'device_execute_task': {
              const result = await this.bridge.executeTask(
                args.deviceId as string,
                args.task as string,
                (args.timeoutMs as number) ?? 300_000,
              );
              const text = result.success
                ? `✅ Task completed: ${result.message ?? ''}\nSteps: ${result.totalSteps ?? 0}\nDuration: ${result.duration ? (result.duration / 1000).toFixed(1) + 's' : 'N/A'}`
                : `❌ Task failed: ${result.message ?? 'Unknown error'}`;
              this.send(id, {
                content: [{ type: "text", text }],
                isError: !result.success,
              });
              break;
            }
            case 'device_cancel_task': {
              await this.bridge.cancelTask(args.deviceId as string, args.taskId as string);
              this.send(id, {
                content: [{ type: "text", text: `Task ${args.taskId} cancelled on ${args.deviceId}` }],
              });
              break;
            }
            case 'device_execute_skill': {
              if (!this.orchestrator) {
                this.sendError(id, -32603, 'device_execute_skill not available (no orchestrator)');
                break;
              }
              const deviceId = args.deviceId as string;
              const action = (args.action as string) ?? 'start';

              let result;
              if (action === 'resume') {
                const taskId = args.taskId as string;
                const subtaskId = args.subtaskId as string;
                const confirmed = args.confirmed as boolean | undefined;
                if (!taskId || !subtaskId || confirmed === undefined) {
                  this.sendError(id, -32602, 'For action="resume": taskId, subtaskId, and confirmed are required.');
                  break;
                }
                result = await this.orchestrator.resumeOrchestration(deviceId, taskId, subtaskId, confirmed);
              } else {
                const task = args.task as string;
                const rawSteps = args.steps as Array<{ name: string; type: string; action?: string; prompt?: string; maxSteps?: number; validation?: string }> | undefined;
                const rawHandlers = args.handlers as Array<{ name: string; trigger: string; strategy: string; action?: string }> | undefined;
                const timeout = Math.min((args.timeout as number) ?? 600_000, 600_000);

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

                result = await this.orchestrator.executeSkillTask(deviceId, task, steps, handlers, timeout);
              }

              let text: string;
              if (result.status === 'needs_confirmation') {
                text = [
                  `⚠️ Confirmation required`,
                  `Sub-task paused: ${result.pendingSubTaskId}`,
                  `Goal: ${(result.pendingContent as Record<string, unknown> | undefined)?.executeGoal as string ?? ''}`,
                  (result.pendingContent as Record<string, unknown> | undefined)?.currentState
                    ? `Preview: ${(result.pendingContent as Record<string, unknown>).currentState as string}`
                    : '',
                  (result.pendingContent as Record<string, unknown> | undefined)?.screenshot
                    ? `📸 Screenshot captured`
                    : '',
                  ``,
                  `To confirm: call device_execute_skill with action="resume", taskId="${result.taskId ?? ''}", subtaskId="${result.pendingSubTaskId ?? ''}", confirmed=true`,
                  `To cancel: call device_execute_skill with action="resume", taskId="${result.taskId ?? ''}", subtaskId="${result.pendingSubTaskId ?? ''}", confirmed=false`,
                ].filter(Boolean).join('\n');
              } else {
                text = result.success
                  ? `✅ Skill task completed\nSub-tasks: ${result.completedSubTasks.length} ok, ${result.failedSubTasks.length} failed`
                  : `❌ Skill task failed: ${result.message}`;
              }
              this.send(id, {
                content: [{ type: "text", text }],
                isError: result.status === 'needs_confirmation' ? false : !result.success,
              });
              break;
            }
            default:
              this.sendError(id, -32601, `Unknown tool: ${name}`);
          }
          break;
        }

        // ── Notifications (no response) ──
        case 'notifications/initialized':
        case 'notifications/cancelled':
          break;

        default:
          this.sendError(id, -32601, `Unknown method: ${msg.method}`);
      }
    } catch (err) {
      const msg2 = err instanceof Error ? err.message : String(err);
      this.sendError(id, -32603, msg2);
    }
  }
}

// ── Main ──

async function main() {
  const wsPort = parseInt(process.env.TABBY_WS_PORT ?? '18800', 10);

  // Start services
  const ipcNotifier = (_channel: string, _data: unknown) => {};
  const wsServer = new WsServer(wsPort, ipcNotifier);
  const coordinator = new TaskCoordinator(wsServer, ipcNotifier);
  wsServer.setTaskMessageHandler(coordinator.handleTaskMessage.bind(coordinator));

  const orchestrator = new Orchestrator(coordinator);

  const phoneServer = createServer();
  wsServer.attachToServer(phoneServer);
  phoneServer.listen(wsPort, '0.0.0.0', () => {
    log(`WebSocket server listening on ws://0.0.0.0:${wsPort}/phone`);
  });

  log('tabby-control MCP server started');

  // Create bridge that Hermes calls through MCP
  const bridge: DeviceBridge = {
    ping: async () => true,
    listDevices: () => Promise.resolve(wsServer.getRegistry().list()),
    getStatus: (deviceId) => Promise.resolve(coordinator.getDeviceStatus(deviceId)),
    executeTask: (deviceId, task, timeoutMs, guidance, sessionId, maxSteps, allowedActions, allowedApps) =>
      coordinator.executeTask(deviceId, task, timeoutMs, guidance, sessionId, maxSteps, allowedActions, allowedApps),
    executeTaskAll: (task, timeoutMs) => coordinator.executeTaskAll(task, timeoutMs).then(m => Object.fromEntries(m)),
    executeBatch: (tasks, timeoutMs) => coordinator.executeBatch(tasks, timeoutMs).then(m => Object.fromEntries(m)),
    cancelTask: async (deviceId, taskId) => { coordinator.cancelTask(deviceId, taskId); },
    executeSubTask: (deviceId, params, timeoutMs) => coordinator.executeSubTask(deviceId, params, timeoutMs),
    resumeOrchestration: (deviceId, params) => coordinator.resumeOrchestration(deviceId, params),
    sendTaskStart: (deviceId, params) => coordinator.sendTaskStart(deviceId, params),
    sendTaskEnd: (deviceId, params) => coordinator.sendTaskEnd(deviceId, params),
  };

  // Start MCP stdio protocol
  const mcp = new McpServer(bridge, orchestrator);
  mcp.start();
}

main().catch((err) => {
  log(`fatal: ${err.message}`);
  process.exit(1);
});
