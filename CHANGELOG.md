# Changelog

All notable changes to this project will be documented in this file.

## [1.0.0] — 2026-04-07

### Added

- Initial release of `@youngclaw/openclaw-lobster-device-control`
- 6 OpenClaw tools: `device:list`, `device:execute_task`, `device:execute_task_all`,
  `device:execute_batch`, `device:cancel_task`, `device:get_status`
- WebSocket server (`WsServer`) with device registry and auth handshake
- Task coordinator (`TaskCoordinator`) for task dispatch and result collection
- HTTP RPC bridge client (`BridgeClient`) for plugin → Electron communication
- Zod schemas for the full phone ↔ PC protocol (task, mirror, control channels)
- `openclaw.plugin.json` manifest compatible with OpenClaw 2026.3.22+
