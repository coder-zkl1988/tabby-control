/**
 * LAN pairing protocol v1, desktop side (TabbyApp docs/lan-pairing-protocol.md §3).
 *
 *   POST   {pair}/requests        phone asks to pair → 201 {requestId, code, expiresInSec, pollIntervalMs}
 *   GET    {pair}/requests/{id}   phone polls → {status: pending|approved|rejected|expired, wsUrl?}
 *   DELETE {pair}/requests/{id}   phone cancelled
 *
 * Requests live in memory only. A human approves on the desktop (via the
 * controller RPC, never over this port); approval mints a device key pre-bound
 * to the requesting deviceId and the phone receives the keyed `ws://` URL —
 * exactly what a QR code would have given it.
 */

import { randomBytes, randomInt } from 'crypto';
import fs from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import { homedir, networkInterfaces } from 'os';
import path from 'path';

export const PAIR_PATH = '/api/v1/pair';
export const PAIRING_REQUEST_TTL_MS = 120_000;
export const PAIRING_POLL_INTERVAL_MS = 1_500;
/** Decided/expired requests stay answerable this long before GET turns into 404. */
const DECIDED_RETENTION_MS = 60_000;
const MAX_PENDING_PER_SOURCE = 3;
const MAX_PENDING_TOTAL = 10;
const MAX_CREATES_PER_SOURCE_PER_MINUTE = 10;
const MAX_BODY_BYTES = 4096;

export type PairingState = 'pending' | 'approved' | 'rejected' | 'expired';

export interface PairingRequestRecord {
  requestId: string;
  code: string;
  deviceId: string;
  model: string;
  manufacturer: string;
  sourceIp: string;
  /** Local address the phone reached us on — the best host for its wsUrl. */
  localAddress?: string;
  createdAt: number;
  expiresAt: number;
  state: PairingState;
  decidedAt?: number;
  wsUrl?: string;
}

/** What the desktop UI sees: never the key or wsUrl. */
export interface PendingPairingView {
  requestId: string;
  code: string;
  deviceId: string;
  model: string;
  manufacturer: string;
  createdAt: number;
  expiresAt: number;
}

export type CreateResult =
  | { ok: true; request: PairingRequestRecord }
  | { ok: false; status: 400 | 403 | 429; message: string };

export interface PairingRequestStoreOptions {
  clock?: () => number;
  ttlMs?: number;
  /** Called whenever the set of pending requests changes. */
  onChange?: () => void;
  /** Return false to refuse new requests with 403. */
  accepting?: () => boolean;
}

export function generatePairingCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export class PairingRequestStore {
  private requests = new Map<string, PairingRequestRecord>();
  private createLog = new Map<string, number[]>();
  private readonly clock: () => number;
  private readonly ttlMs: number;
  private readonly onChange?: () => void;
  private readonly accepting: () => boolean;

  constructor(opts: PairingRequestStoreOptions = {}) {
    this.clock = opts.clock ?? Date.now;
    this.ttlMs = opts.ttlMs ?? PAIRING_REQUEST_TTL_MS;
    this.onChange = opts.onChange;
    this.accepting = opts.accepting ?? (() => true);
  }

  create(input: {
    deviceId: string;
    model: string;
    manufacturer: string;
    sourceIp: string;
    localAddress?: string;
  }): CreateResult {
    this.sweep();
    if (!this.accepting()) {
      return { ok: false, status: 403, message: '电脑端当前不接受配对请求' };
    }
    const now = this.clock();

    // A phone that asks again replaces its own pending request (retry after
    // cancel, app restart) instead of counting against the limits.
    let replaced = false;
    for (const r of this.requests.values()) {
      if (r.state === 'pending' && r.deviceId === input.deviceId) {
        this.requests.delete(r.requestId);
        replaced = true;
      }
    }

    const pending = [...this.requests.values()].filter((r) => r.state === 'pending');
    const recent = (this.createLog.get(input.sourceIp) ?? []).filter((t) => now - t < 60_000);
    if (
      pending.length >= MAX_PENDING_TOTAL ||
      pending.filter((r) => r.sourceIp === input.sourceIp).length >= MAX_PENDING_PER_SOURCE ||
      recent.length >= MAX_CREATES_PER_SOURCE_PER_MINUTE
    ) {
      if (replaced) this.onChange?.();
      return { ok: false, status: 429, message: '配对请求太频繁，请稍后再试' };
    }
    recent.push(now);
    this.createLog.set(input.sourceIp, recent);

    const request: PairingRequestRecord = {
      requestId: `pr_${randomBytes(16).toString('hex')}`,
      code: generatePairingCode(),
      deviceId: input.deviceId,
      model: input.model,
      manufacturer: input.manufacturer,
      sourceIp: input.sourceIp,
      localAddress: input.localAddress,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      state: 'pending',
    };
    this.requests.set(request.requestId, request);
    this.onChange?.();
    return { ok: true, request };
  }

  /** Undefined = unknown or long gone (HTTP 404, which the phone reads as expired). */
  get(requestId: string): PairingRequestRecord | undefined {
    this.sweep();
    return this.requests.get(requestId);
  }

  listPending(): PendingPairingView[] {
    this.sweep();
    return [...this.requests.values()]
      .filter((r) => r.state === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(({ requestId, code, deviceId, model, manufacturer, createdAt, expiresAt }) => ({
        requestId,
        code,
        deviceId,
        model,
        manufacturer,
        createdAt,
        expiresAt,
      }));
  }

  /** Approves a pending request; `mintWsUrl` is only called when it is still pending. */
  approve(requestId: string, mintWsUrl: (request: PairingRequestRecord) => string): PairingRequestRecord | undefined {
    const r = this.get(requestId);
    if (!r || r.state !== 'pending') return undefined;
    r.wsUrl = mintWsUrl(r);
    r.state = 'approved';
    r.decidedAt = this.clock();
    this.onChange?.();
    return r;
  }

  reject(requestId: string): boolean {
    const r = this.get(requestId);
    if (!r || r.state !== 'pending') return false;
    r.state = 'rejected';
    r.decidedAt = this.clock();
    this.onChange?.();
    return true;
  }

  /** Phone cancelled: forget the request so the desktop prompt closes. */
  cancel(requestId: string): boolean {
    const r = this.requests.get(requestId);
    if (!r) return false;
    this.requests.delete(requestId);
    if (r.state === 'pending') this.onChange?.();
    return true;
  }

  sweep(): void {
    const now = this.clock();
    let changed = false;
    for (const r of this.requests.values()) {
      if (r.state === 'pending' && now >= r.expiresAt) {
        r.state = 'expired';
        r.decidedAt = now;
        changed = true;
      }
      const decidedAt = r.decidedAt ?? r.expiresAt;
      if (r.state !== 'pending' && now - Math.max(decidedAt, r.expiresAt) >= DECIDED_RETENTION_MS) {
        this.requests.delete(r.requestId);
      }
      // A key-bearing URL is handed out once the phone polls; it must not stay
      // around longer than the request window either way.
      if (r.state === 'approved' && r.decidedAt !== undefined && now - r.decidedAt >= this.ttlMs) {
        this.requests.delete(r.requestId);
      }
    }
    for (const [ip, times] of this.createLog) {
      if (times.every((t) => now - t >= 60_000)) this.createLog.delete(ip);
    }
    if (changed) this.onChange?.();
  }
}

// ─── Hosts and URLs ──────────────────────────────────────────────────────────

function normalizeIPv4(address: string | undefined): string | null {
  if (!address) return null;
  const v4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) return null;
  if (v4.startsWith('127.') || v4 === '0.0.0.0' || v4.startsWith('169.254.')) return null;
  return v4;
}

/**
 * LAN IPv4 most likely reachable from phones. Same rules as the tabby
 * controller's getLocalIp(): skip tunnels/VMs/bridges, prefer en/eth/wlan.
 */
export function lanIPv4(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string | null {
  const isVirtual = (name: string) =>
    /^(utun|llw|awdl|anpi|bridge|vmnet|vboxnet|docker|lo|gif|stf)/.test(name);
  const candidates: string[] = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs || isVirtual(name)) continue;
    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const v4 = normalizeIPv4(addr.address);
      if (!v4) continue;
      if (/^(en|eth|wlan|wifi)/.test(name)) return v4;
      candidates.push(v4);
    }
  }
  return candidates[0] ?? null;
}

/**
 * Host for a phone's wsUrl, best first: the address the phone itself reached
 * us on (proven reachable), an explicit host from the controller, then our
 * own LAN IPv4 guess. Loopback is the last resort and only works on-device.
 */
export function pickPhoneFacingHost(opts: { localAddress?: string; hostOverride?: string; lanIp?: string | null }): string {
  return (
    normalizeIPv4(opts.localAddress) ??
    normalizeIPv4(opts.hostOverride) ??
    (opts.lanIp === undefined ? lanIPv4() : opts.lanIp) ??
    '127.0.0.1'
  );
}

export function buildPhoneWsUrl(host: string, port: number, key: string): string {
  return `ws://${host}:${port}/phone?key=${encodeURIComponent(key)}`;
}

// ─── Desktop identity (mDNS TXT `id`) ────────────────────────────────────────

export const DEFAULT_DESKTOP_ID_FILE = path.join(homedir(), '.openclaw', 'tabby-control', 'desktop-id.json');

/** Stable per-install random id; created on first use. */
export function loadOrCreateDesktopId(file: string = DEFAULT_DESKTOP_ID_FILE): string {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { id?: unknown };
    if (typeof data.id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(data.id)) return data.id;
  } catch {
    /* create below */
  }
  const id = `tb_${randomBytes(12).toString('hex')}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ id }), 'utf8');
  } catch {
    /* an unpersisted id still works for this run */
  }
  return id;
}

// ─── HTTP endpoints ──────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function boundedString(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length > 0 && s.length <= max ? s : null;
}

/**
 * Handles `{PAIR_PATH}/requests[/{id}]`; returns false for any other path so
 * the caller can fall through to its own routes.
 */
export function handlePairingHttp(
  req: IncomingMessage,
  res: ServerResponse,
  store: PairingRequestStore,
): boolean {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/+$/, '');
  const base = `${PAIR_PATH}/requests`;
  if (pathname !== base && !pathname.startsWith(`${base}/`)) return false;

  if (pathname === base) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { message: 'method not allowed' });
      return true;
    }
    void readBody(req)
      .then((raw) => {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          sendJson(res, 400, { message: '请求格式错误' });
          return;
        }
        const deviceId = boundedString(body?.deviceId, 200);
        if (!deviceId) {
          sendJson(res, 400, { message: '缺少 deviceId' });
          return;
        }
        const result = store.create({
          deviceId,
          model: boundedString(body.model, 100) ?? '',
          manufacturer: boundedString(body.manufacturer, 100) ?? '',
          sourceIp: req.socket.remoteAddress ?? 'unknown',
          localAddress: req.socket.localAddress,
        });
        if (!result.ok) {
          sendJson(res, result.status, { message: result.message });
          return;
        }
        sendJson(res, 201, {
          requestId: result.request.requestId,
          code: result.request.code,
          expiresInSec: Math.round((result.request.expiresAt - result.request.createdAt) / 1000),
          pollIntervalMs: PAIRING_POLL_INTERVAL_MS,
        });
      })
      .catch(() => {
        if (!res.headersSent) sendJson(res, 413, { message: '请求过大' });
      });
    return true;
  }

  const requestId = decodeURIComponent(pathname.slice(base.length + 1));
  if (req.method === 'GET') {
    const r = store.get(requestId);
    if (!r) {
      sendJson(res, 404, { message: 'not found' });
    } else if (r.state === 'approved' && r.wsUrl) {
      sendJson(res, 200, { status: 'approved', wsUrl: r.wsUrl });
    } else {
      sendJson(res, 200, { status: r.state === 'approved' ? 'expired' : r.state });
    }
    return true;
  }
  if (req.method === 'DELETE') {
    store.cancel(requestId);
    sendJson(res, 200, { ok: true });
    return true;
  }
  sendJson(res, 405, { message: 'method not allowed' });
  return true;
}
