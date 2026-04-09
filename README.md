# lobster-device-control

> Remote Android device control plugin for [OpenClaw](https://github.com).

Exposes 6 tools to the OpenClaw agent for controlling Android devices via a WebSocket-connected companion app (**LobsterAgent**):

| Tool | Description |
|------|-------------|
| `device:list` | List all connected devices and their status |
| `device:execute_task` | Send a natural language task to a single device |
| `device:execute_task_all` | Broadcast a task to all idle devices in parallel |
| `device:execute_batch` | Send different tasks to different devices in parallel |
| `device:cancel_task` | Cancel a running task on a device |
| `device:get_status` | Get detailed status of a specific device |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    LobsterAI Desktop (Electron)               │
│                                                              │
│  ┌─────────────┐  ┌──────────────────────────────────────┐ │
│  │  OpenClaw   │  │  lobster-device-control (this pkg)   │ │
│  │   agent     │──│  BridgeClient → HTTP POST /rpc        │ │
│  └─────────────┘  └──────────────┬───────────────────────┘ │
│                                   │                           │
│              ┌────────────────────┴────────────────────┐     │
│              │  Electron main process bridge server   │     │
│              │  (http://localhost:18791)               │     │
│              └──────────────┬─────────────────────────┘     │
│                               │                               │
│              ┌────────────────┴────────────────────┐         │
│              │                                     │         │
│  ┌───────────▼───────────┐  ┌────────────────────▼──┐       │
│  │   WsServer            │  │  TaskCoordinator      │       │
│  │   (port 18790, /phone)│  │  (task dispatch +     │       │
│  │   phone connections   │  │   result collection)  │       │
│  └───────────────────────┘  └────────────────────────┘       │
└──────────────────────────────────────────────────────────────┘
                    │ WebSocket
                    ▼
         ┌────────────────────────┐
         │  LobsterAgent App      │
         │  (Android)             │
         │                        │
         │  PhoneAgentRunner      │
         │  (screenshot → VLM →   │
         │   action → repeat)     │
         └────────────────────────┘
```

## Module overview

| File | Purpose |
|------|---------|
| `protocol.ts` | All shared types and Zod schemas |
| `ws-server.ts` | WebSocket server + `DeviceRegistry` |
| `task-coordinator.ts` | Task dispatch and result collection |
| `bridge.ts` | HTTP RPC client (plugin → Electron bridge) |
| `tools.ts` | OpenClaw tool definitions |
| `index.ts` | Plugin entry point (OpenClaw `register()`) |

## Installation

```bash
npm install @youngclaw/openclaw-lobster-device-control
```

The plugin is auto-discovered by OpenClaw via the `openclaw.extensions` field in `package.json`.

## Configuration

Configure via OpenClaw config (or `openclaw.plugin.json`):

```json
{
  "wsPort": 18790,
  "authTokenLifetime": 86400,
  "maxDevices": 3
}
```

## Development

```bash
# Type-check
npm run typecheck

# Build (outputs to dist/)
npm run build

# Lint
npm run lint
```

## Protocol

The WebSocket protocol between the PC bridge server and Android app is defined entirely in `src/protocol.ts` as Zod schemas. See [the plan](../docs/superpowers/plans/Android-device-control-plan.md) for the full protocol specification.

### Message channels

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `task` | bidirectional | Task execution and result |
| `mirror` | bidirectional | Screen snapshots + click/swipe/input events |
| `control` | phone → PC | Device info updates |

## License

MIT
