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
  AuthMessageSchema,
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
        osVersion: capabilities?.osVersion,
        screenWidth: capabilities?.screenWidth,
        screenHeight: capabilities?.screenHeight,
        status: 'idle',
        currentApp: undefined,
        currentTaskId: undefined,
        connectedAt: now,
        lastSeen: now,
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
    s.info = { ...s.info, ...patch, lastSeen: Date.now() };
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

  constructor(
    private port: number,
    private ipcNotifier: (channel: string, data: unknown) => void,
  ) {
    this.registry = new DeviceRegistry();
    this.wss = new WSServer({ noServer: true });
    this.wss.on('connection', this.handleConnection.bind(this));
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  generatePairingToken(tokenLifetimeSec: number): string {
    const token = Array.from({ length: 32 }, () =>
      Math.floor(Math.random() * 16).toString(16),
    ).join('');
    this.authToken = token;
    this.authTokenExpiresAt = Date.now() + tokenLifetimeSec * 1000;
    return token;
  }

  getPairingInfo(): { token: string; expiresAt: number; port: number } {
    return { token: this.authToken, expiresAt: this.authTokenExpiresAt, port: this.port };
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
    if (!session || session.ws.readyState !== WebSocket.OPEN) return false;
    session.ws.send(JSON.stringify(message));
    return true;
  }

  /**
   * Attach to an existing HTTP server (used by Electron main process).
   * Handles upgrade requests at the `/phone` path.
   */
  attachToServer(server: HTTPServer): void {
    server.on('upgrade', (req, socket, head) => {
      if (req.url === '/phone') {
        this.wss.handleUpgrade(req, socket as never, head, (ws) => {
          this.wss.emit('connection', ws, req);
        });
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
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;

        // ── Auth phase ────────────────────────────────────────────────────────
        if (!authed) {
          const result = AuthMessageSchema.safeParse(msg);
          if (!result.success || result.data.token !== this.authToken) {
            ws.send(JSON.stringify({ type: 'error', code: 'AUTH_FAILED' }));
            ws.close(4003, 'auth failed');
            return;
          }
          if (Date.now() > this.authTokenExpiresAt) {
            ws.send(JSON.stringify({ type: 'error', code: 'TOKEN_EXPIRED' }));
            ws.close(4004, 'token expired');
            return;
          }

          clearTimeout(authTimeout);
          deviceId = result.data.deviceId;
          authed = true;

          const session = this.registry.register(deviceId!, ws, result.data.capabilities);
          ws.send(JSON.stringify({ type: 'connected', serverSessionId: deviceId }));
          this.ipcNotifier('device:connected', session.info);
          return;
        }

        // ── Route by channel ──────────────────────────────────────────────────
        const channel = msg.channel as string;

        if (channel === 'task') {
          // Forward to main-process task coordinator via IPC
          this.ipcNotifier('device:task_message', { deviceId, message: msg });
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
      }
    });

    ws.on('error', (err) => {
      console.warn('[lobster-device-control] WS error:', err.message);
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
