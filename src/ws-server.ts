/**
 * tabby-control WebSocket server
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
import { type Server as HTTPServer } from 'http';
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
  private mirrorForwarders = new Map<string, Set<WebSocket>>();
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

    const payload = JSON.stringify({ channel: 'mirror', ...snapshot });
    for (const ws of this.mirrorForwarders.get(deviceId) ?? []) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
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

  addMirrorForwarder(deviceId: string, ws: WebSocket): void {
    if (!this.mirrorForwarders.has(deviceId)) {
      this.mirrorForwarders.set(deviceId, new Set());
    }
    this.mirrorForwarders.get(deviceId)!.add(ws);
  }

  removeMirrorForwarder(deviceId: string, ws: WebSocket): void {
    this.mirrorForwarders.get(deviceId)?.delete(ws);
  }

  getMirrorForwarders(deviceId: string): Set<WebSocket> {
    return this.mirrorForwarders.get(deviceId) ?? new Set();
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
  readonly wss: InstanceType<typeof WSServer>;
  readonly mirrorWss: InstanceType<typeof WSServer>;
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
    this.mirrorWss = new WSServer({ noServer: true });
    this.wss.on('connection', this.handleConnection.bind(this));
    this.mirrorWss.on('connection', this.handleMirrorConnection.bind(this));
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
      console.log(`[tabby-control] sendToDevice(${deviceId}) SKIPPED - not connected`);
      return false;
    }
    const json = JSON.stringify(message);
    session.ws.send(json);
    return true;
  }

/**
   * Attach WebSocket upgrade handler to the OpenClaw gateway HTTP server.
   * Uses prependListener so our handler runs before OpenClaw's own
   * upgrade handler. After a successful upgrade, OpenClaw's handler would
   * destroy the socket, so we neuter socket.end/destroy between our
   * handleUpgrade call and the connection callback.
   */
  attachToServer(server: HTTPServer): void {
    server.prependListener('upgrade', (req, socket, head) => {
      const url = req.url ?? '/';
      console.log(`[tabby-control] TCP upgrade: url=${JSON.stringify(url)}, phone=${url === '/phone'}, mirror=${url === '/mirror'}, remote=${req.socket.remoteAddress}`);
      if (url === '/phone') {
        const origEnd = socket.end.bind(socket);
        const origDestroy = socket.destroy.bind(socket);
        socket.end = () => socket;
        socket.destroy = () => socket as never;
        this.wss.handleUpgrade(req, socket as never, head, (ws) => {
          socket.end = origEnd;
          socket.destroy = origDestroy;
          this.wss.emit('connection', ws, req);
        });
      } else if (req.url === '/mirror') {
        const origEnd = socket.end.bind(socket);
        const origDestroy = socket.destroy.bind(socket);
        const origWrite = socket.write.bind(socket);
        socket.end = () => socket;
        socket.destroy = () => socket as never;
        socket.write = ((data: unknown, ...args: unknown[]) => { 
          console.log(`[tabby-control] mirror socket.write intercepted, ${typeof data === 'string' ? data.substring(0, 80) : Buffer.isBuffer(data) ? `Buffer(${(data as Buffer).length}b)` : typeof data}`);
          return origWrite(data as never, ...(args as never[])); 
        }) as never;
        console.log(`[tabby-control] mirror handleUpgrade starting...`);
        this.mirrorWss.handleUpgrade(req, socket as never, head, (ws) => {
          console.log(`[tabby-control] mirror handleUpgrade SUCCESS`);
          socket.end = origEnd;
          socket.destroy = origDestroy;
          socket.write = origWrite as never;
          this.mirrorWss.emit('connection', ws, req);
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
    this.mirrorWss.close();
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
        const msg = JSON.parse(raw) as Record<string, unknown>;

        // ── Auth phase — no token required, just deviceId ─────────────────────
        if (!authed) {
          // Accept any message with a deviceId — no token check
          console.log(`[tabby-control] auth phase, msg keys: ${Object.keys(msg).join(',')}`);
          const deviceIdCandidate = (msg.deviceId ?? (msg as Record<string, unknown>).device_id) as string | undefined;
          const capabilities = (msg.capabilities ?? (msg as Record<string, unknown>).capabilities) as DeviceCapabilities | undefined;
          if (!deviceIdCandidate) {
            ws.send(JSON.stringify({ type: 'error', code: 'AUTH_FAILED', message: 'deviceId required' }));
            ws.close(4003, 'auth failed');
            console.log(`[tabby-control] auth failed: no deviceId in msg`);
            return;
          }

          clearTimeout(authTimeout);
          deviceId = deviceIdCandidate;
          authed = true;

          const session = this.registry.register(deviceId, ws, capabilities);
          ws.send(JSON.stringify({ type: 'connected', serverSessionId: deviceId }));
          this.ipcNotifier('device:connected', session.info);
          console.log(`[tabby-control] device connected: ${deviceId}`);
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
        console.warn('[tabby-control] Failed to parse message:', err);
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimeout);
      if (deviceId) {
        this.registry.remove(deviceId);
        this.ipcNotifier('device:disconnected', { deviceId });
        console.log(`[tabby-control] device disconnected: ${deviceId}`);
      }
    });

    ws.on('error', (err) => {
      console.warn(`[tabby-control] WS error (deviceId=${deviceId}): ${err.message}`);
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

  private handleMirrorConnection(ws: WebSocket, _req: unknown): void {
    let subscribedDeviceId: string | null = null;

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;

        if (!subscribedDeviceId) {
          const targetDeviceId = (msg.deviceId ?? '') as string;
          if (!targetDeviceId || !this.registry.get(targetDeviceId)) {
            ws.send(JSON.stringify({ type: 'error', code: 'DEVICE_NOT_FOUND', message: `Device ${targetDeviceId} not found` }));
            ws.close(4404, 'device not found');
            return;
          }
          subscribedDeviceId = targetDeviceId;
          this.registry.addMirrorForwarder(targetDeviceId, ws);
          console.log(`[tabby-control] mirror subscriber connected for device: ${targetDeviceId}`);

          const fps = typeof (msg as Record<string, unknown>).fps === 'number' ? (msg as Record<string, unknown>).fps as number : 5;
          this.sendToDevice(targetDeviceId, { channel: 'mirror', type: 'start', deviceId: targetDeviceId, fps });
          console.log(`[tabby-control] sent mirror start to device: ${targetDeviceId} (fps=${fps})`);

          const lastSnapshot = this.registry.get(targetDeviceId)?.lastSnapshot;
          if (lastSnapshot && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ channel: 'mirror', ...lastSnapshot }));
          }
        }

        if (subscribedDeviceId) {
          const channel = msg.channel as string;
          if (channel === 'mirror') {
            const type = msg.type as string;
            if (type === 'click' || type === 'swipe' || type === 'input_text' || type === 'press_key') {
              this.sendToDevice(subscribedDeviceId, msg);
            }
          }
        }
      } catch (err) {
        console.warn('[tabby-control] Failed to parse mirror message:', err);
      }
    });

    ws.on('close', () => {
      if (subscribedDeviceId) {
        console.log(`[tabby-control] mirror subscriber disconnected for device: ${subscribedDeviceId}`);
        this.registry.removeMirrorForwarder(subscribedDeviceId, ws);
        const remaining = this.registry.getMirrorForwarders(subscribedDeviceId);
        if (remaining.size === 0) {
          this.sendToDevice(subscribedDeviceId, { channel: 'mirror', type: 'stop', deviceId: subscribedDeviceId });
          console.log(`[tabby-control] sent mirror stop to device: ${subscribedDeviceId}`);
        }
      }
    });

    ws.on('error', (err) => {
      console.warn(`[tabby-control] mirror WS error (deviceId=${subscribedDeviceId}): ${err.message}`);
    });
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
