# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

`lobster-device-control` is an OpenClaw plugin that enables remote control of Android devices via WebSocket connections from the **LobsterAgent** Android app. It exposes 6 tools to the OpenClaw agent for device management and task execution.

The plugin runs **standalone** — it starts its own WebSocket server (port 18800) and HTTP RPC server (port 18801), without requiring the LobsterAI desktop app.

## Commands

```bash
npm run build        # Compile TypeScript to dist/
npm run typecheck    # Type-check without emitting
npm run lint         # Lint src/ with ESLint
npm run build:watch  # Watch mode for development
```

## Architecture

```
OpenClaw agent → tools.ts (tool definitions)
                     ↓
               InProcessBridge (direct call, no HTTP)
                     ↓
               TaskCoordinator (task dispatch + result collection)
                     ↓
               WsServer + DeviceRegistry (WebSocket phone connections)

HTTP RPC server (port 18801) also exposed for external callers.
WebSocket server (port 18800, path /phone) accepts phone connections.
```

### Module roles

| File | Role |
|------|------|
| `src/protocol.ts` | All shared Zod schemas. Single source of truth for types/schemas used across all other modules. Also defines `DeviceBridge` interface. |
| `src/ws-server.ts` | WebSocket server (`WsServer`) + device session registry (`DeviceRegistry`). Handles phone auth, message routing by channel, and outbound mirror commands (click/swipe/text/key). |
| `src/task-coordinator.ts` | Task dispatch and pending-result promise management. Phone-side results resolve the matching pending Promise. |
| `src/bridge.ts` | `BridgeClient` — HTTP RPC client for the (optional) Electron bridge server. Deprecated in standalone mode. |
| `src/tools.ts` | OpenClaw tool factories. Each tool takes a `DeviceBridge` and returns a tool definition. |
| `src/index.ts` | Plugin entry point. Starts WS server + HTTP RPC server, wires everything together, registers tools with OpenClaw via `api.registerTool()`. |

### WebSocket protocol

The protocol between PC and Android phone is defined entirely in `protocol.ts` as Zod schemas. Three message channels:

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `task` | bidirectional | Execute agent task, report progress, return result |
| `mirror` | bidirectional | Screen snapshots (phone→PC) + click/swipe/text/key events (PC→phone) |
| `control` | phone→PC | Device info updates (current app, status) |

Phones connect at `ws://<pc>:18800/phone`. No authentication token required.

### In-process bridge

In standalone mode, `InProcessBridge` calls `TaskCoordinator` directly (no HTTP overhead). The `DeviceBridge` interface abstracts over this, allowing `tools.ts` to remain unaware of the call mechanism.

## Key design decisions

- **Zod-first protocol**: All wire protocol types are defined as Zod schemas in `protocol.ts`. Import from there, not from other modules.
- **No token auth on phones**: The plugin accepts any phone connection with a valid `deviceId`. Auth is not enforced at the WebSocket layer.
- **Task IDs are opaque strings**: Generated as `t_${Date.now()}_${random}` on the PC side; phones echo them back in results.
- **Timeout per task**: Default 300s, max 600s. Configured per-call via `timeoutMs` parameter.
- **Progress callbacks**: `TaskCoordinator.onProgress()` allows subscribing to real-time step updates from phones during task execution.
