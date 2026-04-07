/**
 * lobster-device-control — OpenClaw plugin entry point
 *
 * Registers 6 device control tools that communicate with the Electron
 * main-process bridge via HTTP RPC (http://localhost:18791).
 *
 * Architecture:
 *   OpenClaw agent calls tool
 *   → bridge.ts HTTP POST /rpc { method, params }
 *   → Electron main-process HTTP handler receives
 *   → routes to WsServer / TaskCoordinator
 *   → returns JSON response
 *   → tool returns result to agent
 *
 * This file runs in the OpenClaw process (Node.js / ESM).
 * The actual WS server and task coordinator run in the Electron main process.
 */

import { BridgeClient } from './bridge.js';
import {
  createDeviceListTool,
  createExecuteTaskTool,
  createExecuteTaskAllTool,
  createExecuteBatchTool,
  createCancelTaskTool,
  createGetStatusTool,
} from './tools.js';

// ─── OpenClaw plugin API types ─────────────────────────────────────────────────
//
// Declared locally so this package can be type-checked standalone.
// At runtime, OpenClaw provides the actual implementations.

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
  // Accept any signature — OpenClaw may call with (id, params) or (params) depending on version
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
  // Factory form: called with session context, may return null to hide tool
  registerTool(factory: (ctx: { sessionKey?: string }) => OpenClawTool | null): void;
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

const BRIDGE_URL = 'http://localhost:18791';

export default {
  id: 'lobster-device-control',
  name: 'LobsterDeviceControl',
  description:
    'Remote Android device control via WebSocket. OpenClaw sends natural language tasks to companion Android apps.',

  configSchema: {
    parse(value: unknown): Record<string, unknown> {
      return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    },
  },

  register(api: OpenClawPluginApi): void {
    const client = new BridgeClient(BRIDGE_URL);

    // Check bridge availability asynchronously — tools report unavailable until ready
    let bridgeAvailable = false;
    client
      .ping()
      .then(ok => {
        bridgeAvailable = ok;
        if (ok) {
          api.logger.info('[lobster-device-control] bridge connected — tools registered.');
        } else {
          api.logger.warn(
            '[lobster-device-control] bridge unreachable at http://localhost:18791 — device tools will be unavailable.',
          );
        }
      })
      .catch(() => {
        api.logger.warn(
          '[lobster-device-control] bridge unreachable at http://localhost:18791 — device tools will be unavailable.',
        );
      });

    // Factory pattern: per-session tool registration
    // Return null to hide the tool for certain sessions
    function makeTool(
      factory: (client: BridgeClient) => OpenClawTool,
    ) {
      return (ctx: { sessionKey?: string }): OpenClawTool | null => {
        // Only expose tools in LobsterAI desktop sessions
        const sessionKey = ctx.sessionKey ?? '';
        const isDesktop =
          sessionKey.startsWith('agent:main:lobsterai:') || sessionKey === '';
        if (!isDesktop) return null;

        const tool = factory(client);
        tool.isAvailable = () => bridgeAvailable;
        return tool;
      };
    }

    api.registerTool(makeTool(createDeviceListTool));
    api.registerTool(makeTool(createExecuteTaskTool));
    api.registerTool(makeTool(createExecuteTaskAllTool));
    api.registerTool(makeTool(createExecuteBatchTool));
    api.registerTool(makeTool(createCancelTaskTool));
    api.registerTool(makeTool(createGetStatusTool));

    api.logger.info(
      '[lobster-device-control] tool factories registered (bridge availability checked asynchronously).',
    );
  },
};
