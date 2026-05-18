# Changelog

All notable changes to this project will be documented in this file.

## [1.0.0] — 2026-04-07

### Added

- Initial release of `@youngclaw/tabby-control`
- 6 Tabby tools: `device_list`, `device_execute_task`, `device_execute_task_all`,
  `device_execute_batch`, `device_cancel_task`, `device_get_status`
- WebSocket server (`WsServer`) with device registry and auth handshake
- Task coordinator (`TaskCoordinator`) for task dispatch and result collection
- HTTP RPC bridge client (`BridgeClient`) for plugin → Electron communication
- Zod schemas for the full phone ↔ PC protocol (task, mirror, control channels)
- `openclaw.plugin.json` manifest compatible with Tabby 2026.3.22+
