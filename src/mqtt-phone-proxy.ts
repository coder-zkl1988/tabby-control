/**
 * MqttPhoneProxy — bridges MQTT messages from phones into the existing
 * DeviceRegistry / TaskCoordinator handlers.
 */

import type { Aedes, PublishPacket } from 'aedes';
import type { DeviceRegistry } from './ws-server.js';
import { MQTT_SUFFIXES, FRAME_HEADER_SEPARATOR, FrameHeaderSchema } from './protocol.js';
import type { ExecuteParams, AgentProgressParams } from './protocol.js';

type TaskMessageHandler = (deviceId: string, message: Record<string, unknown>) => void;
type IpcNotifier = (channel: string, data: unknown) => void;

export class MqttPhoneProxy {
  private aedes: Aedes;
  private registry: DeviceRegistry;
  private taskHandler: TaskMessageHandler | undefined;
  private ipcNotifier: IpcNotifier;

  constructor(
    broker: import('./mqtt-broker.js').MqttBroker,
    registry: DeviceRegistry,
    taskHandler?: TaskMessageHandler,
    ipcNotifier?: IpcNotifier,
  ) {
    this.aedes = broker.getBroker();
    this.registry = registry;
    this.taskHandler = taskHandler;
    this.ipcNotifier = ipcNotifier ?? (() => {});
    this.setupListeners();
  }

  // ── Desktop → Phone ─────────────────────────────────────────────────────

  publishTask(deviceId: string, params: ExecuteParams): void {
    this.aedes.publish({
      topic: `phone/${deviceId}/${MQTT_SUFFIXES.TASK}`,
      payload: Buffer.from(JSON.stringify(params)),
      qos: 1,
      retain: false,
    } as PublishPacket, () => {});
  }

  publishCancel(deviceId: string, taskId: string): void {
    this.aedes.publish({
      topic: `phone/${deviceId}/${MQTT_SUFFIXES.CANCEL}`,
      payload: Buffer.from(JSON.stringify({ taskId })),
      qos: 1,
      retain: false,
    } as PublishPacket, noop);
  }

  publishMirrorCmd(deviceId: string, type: string, params: Record<string, unknown>): void {
    this.aedes.publish({
      topic: `phone/${deviceId}/${MQTT_SUFFIXES.MIRROR_CMD}`,
      payload: Buffer.from(JSON.stringify({ type, params })),
      qos: 0,
      retain: false,
    } as PublishPacket, noop);
  }

  // ── Phone → Desktop listeners ────────────────────────────────────────────

  private setupListeners(): void {
    this.aedes.on('publish', (packet: PublishPacket, client) => {
      if (!client) return;
      if (!client.id.startsWith('phone/')) return;

      const parts = packet.topic.split('/');
      if (parts.length !== 3) return;

      const suffix = parts[2];
      const deviceId = parts[1];
      const payload = toBuffer(packet.payload);

      try {
        switch (suffix) {
          case MQTT_SUFFIXES.HELLO:
            this.handleHello(deviceId, payload);
            break;
          case MQTT_SUFFIXES.STATUS:
            this.handleStatus(deviceId, payload);
            break;
          case MQTT_SUFFIXES.FRAME:
            this.handleFrame(deviceId, payload);
            break;
          case MQTT_SUFFIXES.PROGRESS:
            this.handleProgress(deviceId, payload);
            break;
          case MQTT_SUFFIXES.RESULT:
            this.handleResult(deviceId, payload);
            break;
          case MQTT_SUFFIXES.LOG:
            this.handleLog(deviceId, payload);
            break;
        }
      } catch (err) {
        console.error(`[MqttPhoneProxy] Error handling ${suffix} from ${deviceId}:`, err);
      }
    });
  }

  // Dummy WebSocket for MQTT devices — prevents null-access crashes on session.ws
  private static readonly DUMMY_WS = {
    readyState: 3, // CLOSED
    send: () => {},
    close: () => {},
    ping: () => {},
    terminate: () => {},
    on: () => {},
    off: () => {},
    removeListener: () => {},
    removeEventListener: () => {},
    addEventListener: () => {},
  } as unknown as import('ws').WebSocket;

  private handleHello(deviceId: string, payload: Buffer): void {
    const data = JSON.parse(payload.toString());
    const caps = data.capabilities ?? {};
    this.registry.register(deviceId, MqttPhoneProxy.DUMMY_WS, caps);
    this.ipcNotifier('device:connected', { deviceId, capabilities: caps });
    console.log(`[MqttPhoneProxy] Device ${deviceId} said hello`);
  }

  private handleStatus(deviceId: string, payload: Buffer): void {
    const patch = JSON.parse(payload.toString());
    this.registry.updateStatus(deviceId, patch);
  }

  private handleFrame(deviceId: string, payload: Buffer): void {
    const sepIdx = payload.indexOf(FRAME_HEADER_SEPARATOR);
    if (sepIdx < 0) {
      console.warn(`[MqttPhoneProxy] Invalid frame from ${deviceId}: no separator`);
      return;
    }

    const headerJson = payload.subarray(0, sepIdx).toString();
    const header = FrameHeaderSchema.parse(JSON.parse(headerJson));

    const imageBytes = payload.subarray(sepIdx + 1);

    const snapshot = {
      type: 'realtime' as const,
      screenshot: imageBytes.toString('base64'),
      format: header.fmt as 'jpeg',
      width: header.w,
      height: header.h,
      timestamp: header.ts,
      currentApp: header.app,
      deviceStatus: header.status,
    };

    this.registry.updateSnapshot(deviceId, snapshot);

    // Store raw binary for MQTT-native consumers (avoids base64 re-encoding roundtrip)
    const session = this.registry.get(deviceId);
    if (session) session.lastFrameBuffer = imageBytes;

    this.ipcNotifier('device:snapshot', { deviceId, snapshot });
  }

  private handleProgress(deviceId: string, payload: Buffer): void {
    const params = JSON.parse(payload.toString()) as AgentProgressParams & {
      interaction_request?: { message: string; screenshot?: string };
    };
    this.ipcNotifier('device:task_progress', { deviceId, params });

    if (params.interaction_request) {
      this.ipcNotifier('device:interaction_request', {
        deviceId,
        taskId: params.taskId,
        step: params.step,
        screenshot: params.interaction_request.screenshot,
        message: params.interaction_request.message,
      });
    }
  }

  private handleResult(deviceId: string, payload: Buffer): void {
    const result = JSON.parse(payload.toString());
    const message = {
      id: `resp_${result.taskId}`,
      result,
    };
    if (this.taskHandler) {
      this.taskHandler(deviceId, message as Record<string, unknown>);
    }
    this.ipcNotifier('device:task_result', { deviceId, result });
  }

  private handleLog(deviceId: string, payload: Buffer): void {
    const log = JSON.parse(payload.toString());
    this.ipcNotifier('device:log', { deviceId, log });
  }
}

function toBuffer(payload: string | Buffer): Buffer {
  return Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
}

const noop = () => {};
