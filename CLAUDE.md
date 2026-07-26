# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

`tabby-control` is a Tabby plugin that enables remote control of Android devices via WebSocket connections from the **Tabby Agent** Android app. It exposes 6 tools to the Tabby agent for device management and task execution.

The plugin runs **standalone** — it starts its own WebSocket server (port 18800) and HTTP RPC server (port 18801), without requiring the Tabby desktop app.

## Commands

```bash
npm run build        # Compile TypeScript to dist/
npm run typecheck    # Type-check without emitting
npm run lint         # Lint src/ with ESLint
npm run build:watch  # Watch mode for development
```

## Architecture

```
Tabby agent → tools.ts (tool definitions)
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
| `src/tools.ts` | Tabby tool factories. Each tool takes a `DeviceBridge` and returns a tool definition. |
| `src/index.ts` | Plugin entry point. Starts WS server + HTTP RPC server, wires everything together, registers tools with Tabby via `api.registerTool()`. |

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

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **openclaw-device-control** (957 symbols, 2096 relationships, 79 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/openclaw-device-control/context` | Codebase overview, check index freshness |
| `gitnexus://repo/openclaw-device-control/clusters` | All functional areas |
| `gitnexus://repo/openclaw-device-control/processes` | All execution flows |
| `gitnexus://repo/openclaw-device-control/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
