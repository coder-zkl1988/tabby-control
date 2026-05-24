/**
 * MQTT Broker wrapping aedes v1.
 *
 * Supports both TCP (phone native clients) and WebSocket (browser mirror viewers)
 * on the same port via aedes' auto-detection.
 */

import { Aedes, type PublishPacket } from 'aedes';
import { createServer, type Server as NetServer } from 'node:net';
import type { DeviceRegistry } from './ws-server.js';

type AuthenticateCb = (err: Error | null, success: boolean) => void;
type AuthorizeCb = (err: Error | null, success: boolean) => void;

export class MqttBroker {
  readonly port: number;
  private aedes: Aedes;
  private server: NetServer | null = null;
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
      if (client.id?.startsWith('phone/')) {
        this.registry.scheduleGraceRemoval(client.id.slice(6));
      }
    });
  }

  getBroker(): Aedes {
    return this.aedes;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer(this.aedes.handle.bind(this.aedes));

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`MQTT port ${this.port} already in use`));
        } else {
          reject(err);
        }
      });

      this.server.listen(this.port, '0.0.0.0', () => {
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      let resolved = false;
      const done = () => { if (!resolved) { resolved = true; resolve(); } };

      const timeout = setTimeout(done, 5_000);

      this.aedes.close(() => {
        clearTimeout(timeout);
        this.server?.close(() => {
          this.server = null;
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
    username: string | undefined,
    _password: Buffer | undefined,
    done: AuthenticateCb,
  ): void {
    // Allow all device connections — hello message handles registration
    done(null, true);
  }

  private authorizePublish(
    client: { id: string },
    topic: string,
    _payload: Buffer,
    done: AuthorizeCb,
  ): void {
    // Extract deviceId from clientId: "phone/{deviceId}"
    const deviceId = client.id?.startsWith('phone/') ? client.id.slice(6) : null;
    if (!deviceId) {
      done(null, false);
      return;
    }
    const allowed = topic.startsWith(`phone/${deviceId}/`);
    done(null, allowed);
  }

  private static readonly READONLY_SUFFIXES = ['status', 'frame', 'progress', 'result', 'log'];

  private authorizeSubscribe(
    client: { id: string },
    sub: { topic: string },
    done: AuthorizeCb,
  ): void {
    const deviceId = client.id?.startsWith('phone/') ? client.id.slice(6) : null;
    if (!deviceId) {
      // Non-phone MQTT clients: require a valid deviceId in the topic AND a
      // read-only suffix. This prevents cross-device snooping — without this
      // check, any LAN MQTT client could subscribe to phone/{any}/frame and
      // receive all mirror feeds, since READONLY_SUFFIXES alone doesn't scope
      // to a specific device.
      const parts = sub.topic.split('/');
      if (
        parts.length === 3 &&
        parts[0] === 'phone' &&
        this.registry.get(parts[1])
      ) {
        const suffix = parts[2];
        if (MqttBroker.READONLY_SUFFIXES.includes(suffix)) {
          done(null, true);
          return;
        }
      }
      done(null, false);
      return;
    }
    const allowed = sub.topic.startsWith(`phone/${deviceId}/`);
    done(null, allowed);
  }
}
