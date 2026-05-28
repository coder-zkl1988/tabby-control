/**
 * MQTT Broker wrapping aedes v1.
 *
 * Supports both raw TCP (phone native MQTT clients) and WebSocket (browser
 * mirror viewers) on the same port. Uses first-byte protocol detection:
 * - MQTT CONNECT packets start with byte 0x10
 * - HTTP/WS upgrade requests start with ASCII letters (GET, POST, etc.)
 *
 * Raw TCP connections go directly to aedes; HTTP connections are forwarded to
 * an internal HTTP server that handles WebSocket upgrades via ws.WebSocketServer.
 */

import Aedes, { type PublishPacket } from 'aedes';
import { createServer as createNetServer, type Socket } from 'node:net';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { WebSocketServer, createWebSocketStream } from 'ws';
import type { DeviceRegistry } from './ws-server.js';

type AuthenticateCb = (err: Error | null, success: boolean) => void;
type AuthorizePublishCb = (err: Error | null) => void;
type AuthorizeSubscribeCb = (err: Error | null, sub: unknown) => void;

export class MqttBroker {
  readonly port: number;
  private aedes: Aedes;
  private netServer: ReturnType<typeof createNetServer> | null = null;
  private httpServer: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private registry: DeviceRegistry;

  constructor(port: number, registry: DeviceRegistry) {
    this.port = port;
    this.registry = registry;
    this.aedes = new Aedes({
      authenticate: this.authenticate.bind(this) as never,
      authorizePublish: this.authorizePublish.bind(this) as never,
      authorizeSubscribe: this.authorizeSubscribe.bind(this) as never,
    });

    // Clean up registry when a phone disconnects
    this.aedes.on('clientDisconnect', (client: { id: string }) => {
      console.log(`[MqttBroker] client disconnected: ${client.id}`);
      if (client.id?.startsWith('phone/')) {
        this.registry.removeImmediately(client.id.slice(6));
      }
    });

    this.aedes.on('client', (client: { id: string }) => {
      console.log(`[MqttBroker] client connected: ${client.id}`);
    });

    // Log detailed connection info for debugging phone disconnections
    this.aedes.on('connectionError', (client: { id: string }, err: Error) => {
      console.log(`[MqttBroker] connection error from ${client.id}: ${err.message}`);
    });
  }

  getBroker(): Aedes {
    return this.aedes;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // ── Internal HTTP server for WebSocket upgrades ────────────────────
      this.httpServer = createHttpServer((_req, res) => {
        res.writeHead(404);
        res.end();
      });

      this.wss = new WebSocketServer({ server: this.httpServer });

      this.wss.on('connection', (ws, req) => {
        const remoteIp = req.socket?.remoteAddress ?? 'unknown';
        console.log(`[MqttBroker] WS connection from ${remoteIp}, url=${req.url}`);
        const stream = createWebSocketStream(ws);
        this.aedes.handle(stream);
      });

      // ── Net server with first-byte protocol detection ──────────────────
      // MQTT CONNECT starts with 0x10; HTTP methods start with ASCII letters.
      this.netServer = createNetServer((socket: Socket) => {
        // Pause reading until we peek the first byte
        socket.pause();
        socket.once('data', (chunk: Buffer) => {
          const firstByte = chunk[0];
          if (firstByte === 0x10) {
            // ── Raw TCP MQTT ──────────────────────────────────────────
            console.log(`[MqttBroker] TCP connection from ${socket.remoteAddress}`);
            // Push the chunk back so aedes can read the full CONNECT packet
            socket.unshift(chunk);
            socket.resume();
            this.aedes.handle(socket);
          } else {
            // ── HTTP / WebSocket ───────────────────────────────────────
            console.log(`[MqttBroker] HTTP/WS connection from ${socket.remoteAddress}`);
            // Push the chunk back and hand the socket to the HTTP server
            socket.unshift(chunk);
            socket.resume();
            this.httpServer!.emit('connection', socket);
          }
        });
        socket.resume(); // resume so the 'data' event fires
      });

      this.netServer.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`MQTT port ${this.port} already in use`));
        } else {
          reject(err);
        }
      });

      this.netServer.listen(this.port, '0.0.0.0', () => {
        console.log(`[MqttBroker] Listening on port ${this.port} (TCP + WebSocket)`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      let resolved = false;
      const done = () => { if (!resolved) { resolved = true; resolve(); } };

      const timeout = setTimeout(done, 5_000);

      this.wss?.close();
      this.aedes.close(() => {
        clearTimeout(timeout);
        this.netServer?.close(() => {
          this.netServer = null;
          this.httpServer = null;
          this.wss = null;
          done();
        });
      });
    });
  }

  publish(packet: PublishPacket, done?: () => void): void {
    this.aedes.publish(packet, done ?? (() => {}));
  }

  // ── Hooks ──────────────────────────────────────────────────────────────────

  private authenticate(
    _client: unknown,
    _username: string | undefined,
    _password: Buffer | undefined,
    done: AuthenticateCb,
  ): void {
    // Allow all device connections — hello message handles registration
    done(null, true);
  }

  private static readonly MIRROR_PREFIX = 'nexu-mirror-';
  private static readonly MIRROR_CMD_SUFFIX = 'mirror_cmd';

  private authorizePublish(
    client: { id: string },
    packet: PublishPacket,
    done: AuthorizePublishCb,
  ): void {
    // packet.topic is typed as string but may arrive as Buffer over WebSocket
    const topic = typeof packet.topic === 'string'
      ? packet.topic
      : (packet.topic as unknown as Buffer).toString('utf8');

    // Phone clients: can publish to phone/{deviceId}/*
    const deviceId = client.id?.startsWith('phone/') ? client.id.slice(6) : null;
    if (deviceId) {
      const allowed = topic.startsWith(`phone/${deviceId}/`);
      // aedes authorizePublish: callback(null) to allow, callback(Error) to deny
      if (allowed) {
        done(null);
      } else {
        done(new Error(`Phone ${deviceId} not authorized to publish to ${topic}`));
      }
      return;
    }

    // Mirror clients (nexu-mirror-*): can publish phone/{deviceId}/mirror_cmd
    // to send remote control commands (click, swipe, input_text)
    if (client.id?.startsWith(MqttBroker.MIRROR_PREFIX)) {
      const parts = topic.split('/');
      if (
        parts.length === 3 &&
        parts[0] === 'phone' &&
        parts[2] === MqttBroker.MIRROR_CMD_SUFFIX &&
        this.registry.get(parts[1])
      ) {
        done(null);
        return;
      }
    }

    done(new Error(`Client ${client.id} not authorized to publish to ${topic}`));
  }

  private static readonly READONLY_SUFFIXES = ['status', 'frame', 'progress', 'result', 'log'];

  private authorizeSubscribe(
    client: { id: string },
    sub: { topic: string | Buffer; qos: number },
    done: AuthorizeSubscribeCb,
  ): void {
    // sub.topic is typed as string but may arrive as Buffer over WebSocket
    const topic = typeof sub.topic === 'string'
      ? sub.topic
      : (sub.topic as unknown as Buffer).toString('utf8');
    const deviceId = client.id?.startsWith('phone/') ? client.id.slice(6) : null;
    if (!deviceId) {
      // Non-phone MQTT clients: require a valid deviceId in the topic AND a
      // read-only suffix. This prevents cross-device snooping — without this
      // check, any LAN MQTT client could subscribe to phone/{any}/frame and
      // receive all mirror feeds, since READONLY_SUFFIXES alone doesn't scope
      // to a specific device.
      const parts = topic.split('/');
      if (
        parts.length === 3 &&
        parts[0] === 'phone' &&
        this.registry.get(parts[1])
      ) {
        const suffix = parts[2];
        if (MqttBroker.READONLY_SUFFIXES.includes(suffix)) {
          // aedes authorizeSubscribe: callback(null, sub) to allow, callback(null, null) to deny
          done(null, sub);
          return;
        }
      }
      done(null, null);
      return;
    }
    const allowed = topic.startsWith(`phone/${deviceId}/`);
    done(null, allowed ? sub : null);
  }
}