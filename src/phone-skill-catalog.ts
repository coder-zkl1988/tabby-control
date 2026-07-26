import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  DeviceInfo,
  PhoneSkillBundle,
  PhoneSkillGeneratedManifest,
} from './protocol.js';
import {
  PhoneSkillBundleSchema,
  PhoneSkillGeneratedManifestSchema,
} from './protocol.js';

type SkillMessage = Record<string, unknown>;
type SendToDevice = (deviceId: string, message: object) => boolean;
type UpdateDeviceStatus = (deviceId: string, patch: Partial<DeviceInfo>) => void;

export interface PhoneSkillCatalogOptions {
  bundleText: string;
  manifest: unknown;
  sendToDevice: SendToDevice;
  updateDeviceStatus: UpdateDeviceStatus;
}

export interface PhoneSkillCatalogMetadata {
  schemaVersion: number;
  bundleVersion: number;
  minAppVersion: string;
  digest: string;
  skillCount: number;
}

function paramsOf(message: SkillMessage): Record<string, unknown> {
  const params = message.params;
  return params && typeof params === 'object' && !Array.isArray(params)
    ? params as Record<string, unknown>
    : {};
}

function integerParam(params: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
  }
  return 0;
}

function stringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  return typeof value === 'string' ? value : '';
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value
    .split(/[+-]/, 1)[0]
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

export class PhoneSkillCatalog {
  readonly bundle: PhoneSkillBundle;
  readonly manifest: PhoneSkillGeneratedManifest;
  private readonly bundleBase64: string;
  private readonly sendToDevice: SendToDevice;
  private readonly updateDeviceStatus: UpdateDeviceStatus;

  constructor(options: PhoneSkillCatalogOptions) {
    this.bundle = PhoneSkillBundleSchema.parse(JSON.parse(options.bundleText));
    this.manifest = PhoneSkillGeneratedManifestSchema.parse(options.manifest);
    const actualDigest = createHash('sha256').update(options.bundleText).digest('hex');

    if (
      actualDigest !== this.manifest.digest ||
      this.bundle.schemaVersion !== this.manifest.schemaVersion ||
      this.bundle.bundleVersion !== this.manifest.bundleVersion ||
      this.bundle.minAppVersion !== this.manifest.minAppVersion
    ) {
      throw new Error('Phone skill bundle and manifest do not match');
    }

    const bundleSkills = this.bundle.skills.map(({ id, version }) => ({ id, version }));
    const manifestSkills = this.manifest.skills.map(({ id, version }) => ({ id, version }));
    if (JSON.stringify(bundleSkills) !== JSON.stringify(manifestSkills)) {
      throw new Error('Phone skill list and manifest do not match');
    }

    this.bundleBase64 = Buffer.from(options.bundleText, 'utf8').toString('base64');
    this.sendToDevice = options.sendToDevice;
    this.updateDeviceStatus = options.updateDeviceStatus;
  }

  static loadDefault(
    sendToDevice: SendToDevice,
    updateDeviceStatus: UpdateDeviceStatus,
  ): PhoneSkillCatalog {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const generatedDir = path.resolve(moduleDir, '..', 'generated');
    const bundleText = readFileSync(
      path.join(generatedDir, 'phone-skills.bundle.json'),
      'utf8',
    );
    const manifest = JSON.parse(
      readFileSync(path.join(generatedDir, 'phone-skills.manifest.json'), 'utf8'),
    ) as unknown;
    return new PhoneSkillCatalog({
      bundleText,
      manifest,
      sendToDevice,
      updateDeviceStatus,
    });
  }

  getMetadata(): PhoneSkillCatalogMetadata {
    return {
      schemaVersion: this.bundle.schemaVersion,
      bundleVersion: this.bundle.bundleVersion,
      minAppVersion: this.bundle.minAppVersion,
      digest: this.manifest.digest,
      skillCount: this.bundle.skills.length,
    };
  }

  handleMessage(deviceId: string, message: SkillMessage): boolean {
    const operation = typeof message.method === 'string'
      ? message.method
      : typeof message.type === 'string'
        ? message.type
        : '';
    const params = paramsOf(message);

    if (operation === 'skill.hello') {
      this.handleHello(deviceId, params);
      return true;
    }
    if (operation === 'skill.ack') {
      this.handleAck(deviceId, params);
      return true;
    }
    if (operation === 'skill.nack') {
      this.handleNack(deviceId, params);
      return true;
    }
    return false;
  }

  private handleHello(deviceId: string, params: Record<string, unknown>): void {
    const schemaVersion = integerParam(params, 'schemaVersion');
    const bundleVersion = integerParam(params, 'bundleVersion', 'localVersion');
    const digest = stringParam(params, 'digest');
    const appVersion = stringParam(params, 'appVersion');
    const baseStatus: Partial<DeviceInfo> = {
      skillSchemaVersion: schemaVersion,
      skillBundleVersion: bundleVersion,
      skillDigest: digest || undefined,
      skillSyncError: undefined,
    };

    if (appVersion && compareVersions(appVersion, this.bundle.minAppVersion) < 0) {
      const error = `App ${appVersion} 低于技能要求的 ${this.bundle.minAppVersion}`;
      this.updateDeviceStatus(deviceId, {
        ...baseStatus,
        skillSyncStatus: 'incompatible',
        skillSyncError: error,
      });
      console.warn(`[tabby-control] phone skill sync skipped for ${deviceId}: ${error}`);
      return;
    }

    const isCurrent = bundleVersion === this.bundle.bundleVersion &&
      digest === this.manifest.digest;
    if (isCurrent) {
      this.updateDeviceStatus(deviceId, {
        ...baseStatus,
        skillSyncStatus: 'current',
        skillLastSyncedAt: Date.now(),
      });
      return;
    }

    this.updateDeviceStatus(deviceId, {
      ...baseStatus,
      skillSyncStatus: 'syncing',
    });
    const sent = this.sendToDevice(deviceId, {
      channel: 'skill',
      type: 'skill.sync',
      method: 'skill.sync',
      id: `skill-sync-${this.bundle.bundleVersion}-${Date.now()}`,
      params: {
        schemaVersion: this.bundle.schemaVersion,
        syncVersion: this.bundle.bundleVersion,
        bundleVersion: this.bundle.bundleVersion,
        minAppVersion: this.bundle.minAppVersion,
        digestAlgorithm: 'SHA-256',
        digest: this.manifest.digest,
        bundleBase64: this.bundleBase64,
        // Legacy clients ignore bundleBase64 and consume this compatible form.
        skills: this.bundle.skills,
      },
    });
    if (!sent) {
      this.updateDeviceStatus(deviceId, {
        ...baseStatus,
        skillSyncStatus: 'error',
        skillSyncError: '设备在技能同步下发前已断开',
      });
    }
  }

  private handleAck(deviceId: string, params: Record<string, unknown>): void {
    const schemaVersion = integerParam(params, 'schemaVersion');
    const bundleVersion = integerParam(params, 'bundleVersion', 'syncVersion');
    const digest = stringParam(params, 'digest');
    const legacyAckMatches = schemaVersion === 0 &&
      bundleVersion === this.bundle.bundleVersion &&
      digest === '';
    const current = legacyAckMatches ||
      (
        schemaVersion === this.bundle.schemaVersion &&
        bundleVersion === this.bundle.bundleVersion &&
        digest === this.manifest.digest
      );
    this.updateDeviceStatus(deviceId, {
      skillSchemaVersion: schemaVersion || this.bundle.schemaVersion,
      skillBundleVersion: bundleVersion,
      skillDigest: digest || this.manifest.digest,
      skillSyncStatus: current ? 'current' : 'error',
      skillSyncError: current ? undefined : '设备确认的技能版本或摘要与桌面端不一致',
      skillLastSyncedAt: current ? Date.now() : undefined,
    });
  }

  private handleNack(deviceId: string, params: Record<string, unknown>): void {
    const code = stringParam(params, 'code') || 'SKILL_SYNC_FAILED';
    const message = stringParam(params, 'message') || '手机端拒绝了技能同步';
    const activeSchemaVersion = integerParam(params, 'activeSchemaVersion') ||
      integerParam(params, 'schemaVersion');
    const activeBundleVersion = integerParam(params, 'activeBundleVersion') ||
      integerParam(params, 'bundleVersion', 'syncVersion');
    const activeDigest = stringParam(params, 'activeDigest') ||
      stringParam(params, 'digest');
    this.updateDeviceStatus(deviceId, {
      skillSchemaVersion: activeSchemaVersion || undefined,
      skillBundleVersion: activeBundleVersion || undefined,
      skillDigest: activeDigest || undefined,
      skillSyncStatus: 'error',
      skillSyncError: `${code}: ${message}`,
    });
    console.warn(`[tabby-control] phone skill sync failed for ${deviceId}: ${code}: ${message}`);
  }
}
