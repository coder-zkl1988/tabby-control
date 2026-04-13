/**
 * lobster-device-control WebSocket server
 *
 * Handles phone connections, auth handshake, message routing by channel,
 * and notifies the Electron main process via IPC callbacks.
 *
 * Architecture:
 *   Phone WS connects at /phone → auth → session registered
 *   ┌─ 'task' messages  → forwarded via ipcNotifier('device:task_message', ...)
 *   ├─ 'mirror' messages → parsed, registry updated, forwarded via ipcNotifier(...)
 *   └─ outbound: sendMirrorClick/Swipe/Text/Key → PC → phone
 */

import WebSocket, { WebSocketServer as WSServer } from 'ws';
import type { Server as HTTPServer } from 'http';
import type {
  DeviceInfo,
  DeviceCapabilities,
  MirrorSnapshot,
  MirrorClickParams,
  MirrorSwipeParams,
  MirrorTextParams,
  MirrorKeyParams,
} from './protocol.js';
import {
  MirrorSnapshotSchema,
} from './protocol.js';

// ─── DeviceSession ───────────────────────────────────────────────────────────

export interface DeviceSession {
  deviceId: string;
  ws: WebSocket;
  info: DeviceInfo;
  lastSnapshot?: MirrorSnapshot;
}

// ─── DeviceRegistry ──────────────────────────────────────────────────────────

type DeviceChangeCallback = (devices: DeviceInfo[]) => void;

// ── Human-readable unit conversion helpers ─────────────────────────────────────

/** Convert bytes to human-readable string (KB/MB/GB/TB) */
function formatBytes(bytes: number | undefined): string | undefined {
  if (bytes == null || bytes <= 0) return undefined;
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(2)} TB`;
  if (bytes >= 1e9)  return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6)  return `${(bytes / 1e6).toFixed(2)} MB`;
  return `${(bytes / 1e3).toFixed(2)} KB`;
}

/** Convert Android SDK version number to "Android XX" string */
function formatOsVersion(v: number | string | undefined): string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') return v; // already formatted
  // Android version map: 35=Android 15, 36=Android 16, etc.
  const map: Record<number, string> = {
    29: 'Android 10', 30: 'Android 11', 31: 'Android 12',
    32: 'Android 12L', 33: 'Android 13', 34: 'Android 14',
    35: 'Android 15', 36: 'Android 16',
  };
  return map[v] ?? `Android ${v - 9}`; // fallback: v - 9 as rough estimate
}

export class DeviceRegistry {
  private devices = new Map<string, DeviceSession>();
  private changeCallbacks: DeviceChangeCallback[] = [];

  register(deviceId: string, ws: WebSocket, capabilities?: DeviceCapabilities): DeviceSession {
    const now = Date.now();
    const session: DeviceSession = {
      deviceId,
      ws,
      info: {
        deviceId,
        model: capabilities?.model,
        osVersion: formatOsVersion(capabilities?.osVersion),
        screenWidth: capabilities?.screenWidth,
        screenHeight: capabilities?.screenHeight,
        status: 'idle',
        currentApp: capabilities?.currentApp,
        currentTaskId: undefined,
        connectedAt: now,
        lastSeen: now,
        manufacturer: capabilities?.manufacturer,
        batteryLevel: capabilities?.batteryLevel,
        batteryStatus: capabilities?.batteryStatus,
        isCharging: capabilities?.isCharging,
        totalRam: formatBytes(capabilities?.totalRam),
        availableRam: formatBytes(capabilities?.availableRam),
        totalStorage: formatBytes(capabilities?.totalStorage),
        availableStorage: formatBytes(capabilities?.availableStorage),
        wifiSsid: capabilities?.wifiSsid,
        isWifiConnected: capabilities?.isWifiConnected,
      },
    };
    this.devices.set(deviceId, session);
    this.notifyChange();
    return session;
  }

  get(deviceId: string): DeviceSession | undefined {
    return this.devices.get(deviceId);
  }

  list(): DeviceInfo[] {
    return Array.from(this.devices.values()).map(s => s.info);
  }

  sessions(): DeviceSession[] {
    return Array.from(this.devices.values());
  }

  updateStatus(deviceId: string, patch: Partial<DeviceInfo>): void {
    const s = this.devices.get(deviceId);
    if (!s) return;
    // Apply unit conversions for fields that arrive as raw numbers
    const converted: Partial<DeviceInfo> = {
      ...patch,
      osVersion: formatOsVersion(patch.osVersion as number | string | undefined),
      totalRam: formatBytes(patch.totalRam as number | undefined),
      availableRam: formatBytes(patch.availableRam as number | undefined),
      totalStorage: formatBytes(patch.totalStorage as number | undefined),
      availableStorage: formatBytes(patch.availableStorage as number | undefined),
    };
    s.info = { ...s.info, ...converted, lastSeen: Date.now() };
    this.notifyChange();
  }

  updateSnapshot(deviceId: string, snapshot: MirrorSnapshot): void {
    const s = this.devices.get(deviceId);
    if (!s) return;
    s.lastSnapshot = snapshot;
    s.info = {
      ...s.info,
      currentApp: snapshot.currentApp,
      status: snapshot.deviceStatus,
      lastSeen: snapshot.timestamp,
    };
    this.notifyChange();
  }

  remove(deviceId: string): void {
    if (this.devices.delete(deviceId)) {
      this.notifyChange();
    }
  }

  onDeviceChange(callback: DeviceChangeCallback): () => void {
    this.changeCallbacks.push(callback);
    return () => {
      this.changeCallbacks = this.changeCallbacks.filter(cb => cb !== callback);
    };
  }

  private notifyChange(): void {
    const devices = this.list();
    for (const cb of this.changeCallbacks) {
      try { cb(devices); } catch { /* ignore */ }
    }
  }
}

// ─── MirrorHandler ────────────────────────────────────────────────────────────

export interface MirrorHandler {
  onClick?: (deviceId: string, params: MirrorClickParams) => void;
  onSwipe?: (deviceId: string, params: MirrorSwipeParams) => void;
  onText?: (deviceId: string, params: MirrorTextParams) => void;
  onKey?: (deviceId: string, params: MirrorKeyParams) => void;
}

// ─── WsServer ────────────────────────────────────────────────────────────────

export class WsServer {
  private wss: InstanceType<typeof WSServer>;
  private registry: DeviceRegistry;
  private authToken = '';
  private authTokenExpiresAt = 0;
  private mirrorHandler?: MirrorHandler;
  /** Direct handler for task messages — called synchronously when a phone sends a task response */
  private taskMessageHandler?: (deviceId: string, message: Record<string, unknown>) => void;

  constructor(
    private port: number,
    private ipcNotifier: (channel: string, data: unknown) => void,
  ) {
    this.registry = new DeviceRegistry();
    this.wss = new WSServer({ noServer: true });
    this.wss.on('connection', this.handleConnection.bind(this));
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Register a handler that is called directly (in-process) when a task message
   * arrives from a phone. This avoids IPC overhead in standalone mode.
   */
  generatePairingToken(tokenLifetimeSec: number): string {
    const token = Array.from({ length: 32 }, () =>
      Math.floor(Math.random() * 16).toString(16),
    ).join('');
    this.authToken = token;
    this.authTokenExpiresAt = Date.now() + tokenLifetimeSec * 1000;
    return token;
  }

  setTaskMessageHandler(handler: (deviceId: string, message: Record<string, unknown>) => void): void {
    this.taskMessageHandler = handler;
  }

  getRegistry(): DeviceRegistry {
    return this.registry;
  }

  setMirrorHandler(handler: MirrorHandler): void {
    this.mirrorHandler = handler;
  }

  /**
   * Send a JSON message to a device. Returns false if the device is not connected.
   */
  sendToDevice(deviceId: string, message: object): boolean {
    const session = this.registry.get(deviceId);
    if (!session || session.ws.readyState !== WebSocket.OPEN) {
      console.log(`[lobster-device-control] sendToDevice(${deviceId}) SKIPPED - not connected`);
      return false;
    }
    const json = JSON.stringify(message);
    console.log(`[lobster-device-control] >>> WS_SEND >>> deviceId=${deviceId} raw=${json}`);
    session.ws.send(json);
    return true;
  }

  /**
   * Attach to an existing HTTP server (used by Electron main process).
   * Handles upgrade requests at the `/phone` path.
   */
  attachToServer(server: HTTPServer): void {
    server.on('upgrade', (req, socket, head) => {
      console.log(`[lobster-device-control] TCP upgrade: url=${req.url}, remote=${req.socket.remoteAddress}`);
      if (req.url === '/phone') {
        this.wss.handleUpgrade(req, socket as never, head, (ws) => {
          this.wss.emit('connection', ws, req);
        });
      } else {
        console.log(`[lobster-device-control] upgrade rejected: url=${req.url} != /phone`);
        socket.destroy();
      }
    });
  }

  /** Start standalone (for testing without Electron). */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      (this.wss as unknown as { listen(port: number): void }).listen(this.port);
      this.wss.on('error', reject);
      this.wss.on('listening', () => resolve());
    });
  }

  /** Close all device connections and stop the server. */
  stop(): void {
    for (const session of this.registry.sessions()) {
      session.ws.close(1000, 'server shutdown');
    }
    this.wss.close();
  }

  // ─── Connection Handler ─────────────────────────────────────────────────────

  private handleConnection(ws: WebSocket, _req: unknown): void {
    let deviceId: string | null = null;
    let authed = false;

    // Auth must complete within 15s
    const authTimeout = setTimeout(() => {
      if (!authed) {
        ws.send(JSON.stringify({ type: 'error', code: 'AUTH_TIMEOUT' }));
        ws.close(4001, 'auth timeout');
      }
    }, 15_000);

    ws.on('message', (data) => {
      try {
        const raw = data.toString();
        console.log(`[lobster-device-control] ws message received: ${raw}`);
        const msg = JSON.parse(raw) as Record<string, unknown>;

        // ── Auth phase — no token required, just deviceId ─────────────────────
        if (!authed) {
          // Accept any message with a deviceId — no token check
          console.log(`[lobster-device-control] auth phase, msg keys: ${Object.keys(msg).join(',')}`);
          const deviceIdCandidate = (msg.deviceId ?? (msg as Record<string, unknown>).device_id) as string | undefined;
          const capabilities = (msg.capabilities ?? (msg as Record<string, unknown>).capabilities) as DeviceCapabilities | undefined;
          if (!deviceIdCandidate) {
            ws.send(JSON.stringify({ type: 'error', code: 'AUTH_FAILED', message: 'deviceId required' }));
            ws.close(4003, 'auth failed');
            console.log(`[lobster-device-control] auth failed: no deviceId in msg`);
            return;
          }

          clearTimeout(authTimeout);
          deviceId = deviceIdCandidate;
          authed = true;

          const session = this.registry.register(deviceId, ws, capabilities);
          ws.send(JSON.stringify({ type: 'connected', serverSessionId: deviceId }));
          this.ipcNotifier('device:connected', session.info);
          console.log(`[lobster-device-control] device connected: ${deviceId}`);
          return;
        }

        // ── Route by channel ──────────────────────────────────────────────────
        const channel = msg.channel as string;

        if (channel === 'task') {
          // In standalone mode: call taskMessageHandler directly (same process, no IPC needed)
          if (this.taskMessageHandler) {
            this.taskMessageHandler(deviceId!, msg);
          } else {
            // Fall back to IPC for Electron main process
            this.ipcNotifier('device:task_message', { deviceId, message: msg });
          }
        } else if (channel === 'mirror') {
          this.handleMirrorMessage(deviceId!, msg);
        } else if (channel === 'control') {
          this.handleControlMessage(deviceId!, msg);
        }
      } catch (err) {
        console.warn('[lobster-device-control] Failed to parse message:', err);
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimeout);
      if (deviceId) {
        this.registry.remove(deviceId);
        this.ipcNotifier('device:disconnected', { deviceId });
        console.log(`[lobster-device-control] device disconnected: ${deviceId}`);
      }
    });

    ws.on('error', (err) => {
      console.warn(`[lobster-device-control] WS error (deviceId=${deviceId}): ${err.message}`);
    });
  }

  private handleMirrorMessage(deviceId: string, msg: Record<string, unknown>): void {
    if (msg.type === 'snapshot' || msg.type === 'realtime') {
      const parsed = MirrorSnapshotSchema.safeParse(msg);
      if (parsed.success) {
        this.registry.updateSnapshot(deviceId, parsed.data);
        this.ipcNotifier('device:snapshot', { deviceId, snapshot: parsed.data });
      }
      return;
    }

    // PC → phone control commands (triggered by MirrorHandler from renderer)
    if (msg.type === 'click' && this.mirrorHandler?.onClick) {
      this.mirrorHandler.onClick(deviceId, msg.params as MirrorClickParams);
    } else if (msg.type === 'swipe' && this.mirrorHandler?.onSwipe) {
      this.mirrorHandler.onSwipe(deviceId, msg.params as MirrorSwipeParams);
    } else if (msg.type === 'input_text' && this.mirrorHandler?.onText) {
      this.mirrorHandler.onText(deviceId, msg.params as MirrorTextParams);
    } else if (msg.type === 'press_key' && this.mirrorHandler?.onKey) {
      this.mirrorHandler.onKey(deviceId, msg.params as MirrorKeyParams);
    }
  }

  private handleControlMessage(deviceId: string, msg: Record<string, unknown>): void {
    const event = msg.event as string;
    if (event === 'device_info') {
      this.registry.updateStatus(deviceId, msg as Partial<DeviceInfo>);
    }
  }

  // ─── Outbound mirror commands (PC → phone) ──────────────────────────────────

  sendMirrorClick(deviceId: string, params: MirrorClickParams): void {
    this.sendToDevice(deviceId, { channel: 'mirror', type: 'click', params });
  }

  sendMirrorSwipe(deviceId: string, params: MirrorSwipeParams): void {
    this.sendToDevice(deviceId, { channel: 'mirror', type: 'swipe', params });
  }

  sendMirrorText(deviceId: string, params: MirrorTextParams): void {
    this.sendToDevice(deviceId, { channel: 'mirror', type: 'input_text', params });
  }

  sendMirrorKey(deviceId: string, params: MirrorKeyParams): void {
    this.sendToDevice(deviceId, { channel: 'mirror', type: 'press_key', params });
  }
}
