/**
 * Device keys for phone WebSocket auth (docs: TabbyApp lan-pairing-protocol.md,
 * desktop-to-phone-token-security-risk.md). Modelled on Octop's companion
 * PairingStore:
 *
 * - Every QR code / approved LAN pairing carries a fresh random key in the
 *   `ws://…/phone?key=…` URL. Only its SHA-256 is stored.
 * - The first phone that connects with a key claims it: from then on only that
 *   `deviceId` may use it. A LAN pairing pre-binds the key to the requesting
 *   `deviceId`, so nobody else can claim it even before first use.
 * - A key nobody has connected with yet expires after UNCLAIMED_KEY_TTL_MS.
 * - Claiming a new key drops the device's previous record (re-pairing replaces).
 *
 * Only a phone that passes this check receives the `connected` envelope with
 * the user's VLM credential.
 */

import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import { homedir } from 'os';
import path from 'path';

export const UNCLAIMED_KEY_TTL_MS = 600_000;

/** Shown on the phone when its key is missing or no longer valid. */
export const PAIRING_REQUIRED_MESSAGE = '设备未配对或配对已失效，请重新扫码或配对';

export const DEFAULT_DEVICE_KEYS_FILE = path.join(
  homedir(),
  '.openclaw',
  'tabby-control',
  'paired-devices.json',
);

export interface DeviceKeyRecord {
  keySha256: string;
  createdAt: number;
  /** Set when claimed, or pre-bound by an approved LAN pairing request. */
  deviceId?: string;
  claimedAt?: number;
  model?: string;
  source: 'qr' | 'lan';
}

export type AuthDecision =
  | { ok: true; record: DeviceKeyRecord; claimedNow: boolean }
  | {
      ok: false;
      code: 'PAIRING_REQUIRED';
      reason: 'missing_key' | 'unknown_key' | 'device_mismatch';
      message: string;
    };

export function hashKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export function generateDeviceKey(): string {
  return randomBytes(32).toString('base64url');
}

export function isExpiredUnclaimed(record: DeviceKeyRecord, now: number): boolean {
  return record.claimedAt === undefined && now - record.createdAt > UNCLAIMED_KEY_TTL_MS;
}

/** Pure auth decision; does not mutate `records`. */
export function decideAuth(
  records: readonly DeviceKeyRecord[],
  key: string | null | undefined,
  deviceId: string,
  now: number,
): AuthDecision {
  const fail = (reason: 'missing_key' | 'unknown_key' | 'device_mismatch'): AuthDecision => ({
    ok: false,
    code: 'PAIRING_REQUIRED',
    reason,
    message: PAIRING_REQUIRED_MESSAGE,
  });
  if (!key) return fail('missing_key');
  const digest = hashKey(key);
  const match = records.find((r) => r.keySha256 === digest && !isExpiredUnclaimed(r, now));
  if (!match) return fail('unknown_key');
  if (match.deviceId !== undefined && match.deviceId !== deviceId) return fail('device_mismatch');
  return { ok: true, record: match, claimedNow: match.claimedAt === undefined };
}

/**
 * Records after `deviceId` claims `record`: the claimed record replaces the
 * original and any other record of that device is dropped (a phone that
 * re-pairs gives up its previous key).
 */
export function applyClaim(
  records: readonly DeviceKeyRecord[],
  record: DeviceKeyRecord,
  deviceId: string,
  now: number,
  model?: string,
): DeviceKeyRecord[] {
  const claimed: DeviceKeyRecord = {
    ...record,
    deviceId,
    claimedAt: now,
    ...(model ? { model } : {}),
  };
  return records
    .filter((r) => r.keySha256 !== record.keySha256 && r.deviceId !== deviceId)
    .concat(claimed);
}

function parseRecord(raw: unknown): DeviceKeyRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.keySha256 !== 'string' || !/^[0-9a-f]{64}$/.test(r.keySha256)) return null;
  if (typeof r.createdAt !== 'number') return null;
  return {
    keySha256: r.keySha256,
    createdAt: r.createdAt,
    ...(typeof r.deviceId === 'string' && r.deviceId ? { deviceId: r.deviceId } : {}),
    ...(typeof r.claimedAt === 'number' ? { claimedAt: r.claimedAt } : {}),
    ...(typeof r.model === 'string' && r.model ? { model: r.model } : {}),
    source: r.source === 'lan' ? 'lan' : 'qr',
  };
}

export interface DeviceKeyStoreOptions {
  /** Persistence file; null keeps keys in memory only (tests). */
  file?: string | null;
  clock?: () => number;
  logger?: { warn(msg: string): void };
}

export class DeviceKeyStore {
  private records: DeviceKeyRecord[] = [];
  private readonly file: string | null;
  private readonly clock: () => number;
  private readonly logger?: { warn(msg: string): void };

  constructor(opts: DeviceKeyStoreOptions = {}) {
    this.file = opts.file === undefined ? DEFAULT_DEVICE_KEYS_FILE : opts.file;
    this.clock = opts.clock ?? Date.now;
    this.logger = opts.logger;
    this.load();
  }

  /** Mints a key; returns the plaintext (never stored). */
  mint(opts: { source: 'qr' | 'lan'; deviceId?: string; model?: string }): string {
    const key = generateDeviceKey();
    this.reload();
    this.records.push({
      keySha256: hashKey(key),
      createdAt: this.clock(),
      source: opts.source,
      ...(opts.deviceId ? { deviceId: opts.deviceId } : {}),
      ...(opts.model ? { model: opts.model } : {}),
    });
    this.save();
    return key;
  }

  authenticate(key: string | null | undefined, deviceId: string, model?: string): AuthDecision {
    this.reload();
    const now = this.clock();
    const decision = decideAuth(this.records, key, deviceId, now);
    if (decision.ok && decision.claimedNow) {
      this.records = applyClaim(this.records, decision.record, deviceId, now, model);
      this.save();
    }
    return decision;
  }

  /** Claimed devices (no key material). */
  listClaimed(): Array<{ deviceId: string; claimedAt: number; model?: string; source: 'qr' | 'lan' }> {
    this.reload();
    return this.records
      .filter((r) => r.deviceId !== undefined && r.claimedAt !== undefined)
      .map((r) => ({ deviceId: r.deviceId!, claimedAt: r.claimedAt!, model: r.model, source: r.source }));
  }

  private load(): void {
    this.records = this.readFile();
  }

  /**
   * Re-read before each operation: several OpenClaw workers may load this
   * plugin, and only the one that owns the phone port mints and checks keys —
   * but a restart must never resurrect a stale in-memory copy over the file.
   */
  private reload(): void {
    if (this.file) this.records = this.readFile();
  }

  private readFile(): DeviceKeyRecord[] {
    if (!this.file) return this.records;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
      const list = Array.isArray(data) ? data : [];
      const now = this.clock();
      return list
        .map(parseRecord)
        .filter((r): r is DeviceKeyRecord => r !== null && !isExpiredUnclaimed(r, now));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger?.warn(
          `[tabby-control] Ignoring unreadable device key file: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return [];
    }
  }

  private save(): void {
    const now = this.clock();
    this.records = this.records.filter((r) => !isExpiredUnclaimed(r, now));
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.records), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.logger?.warn(
        `[tabby-control] Failed to persist device keys: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** The `key` query parameter of a phone upgrade URL (`/phone?key=…`). */
export function phoneKeyFromRequestUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const key = new URL(url, 'http://localhost').searchParams.get('key');
    return key && key.length > 0 ? key : null;
  } catch {
    return null;
  }
}
