/**
 * mDNS / DNS-SD advertisement of the phone-facing port as `_itabby._tcp`
 * (TabbyApp docs/lan-pairing-protocol.md §2). The TXT record carries no key
 * and no user data — only protocol version, kind, display name, the stable
 * per-install id and the pairing path.
 */

import Bonjour from 'bonjour-service';
import { execFileSync } from 'child_process';
import { hostname, userInfo } from 'os';
import { PAIR_PATH } from './pairing.js';

export const SERVICE_TYPE = 'itabby'; // published as _itabby._tcp

/** macOS `scutil --get <key>` (ComputerName / LocalHostName), or null elsewhere. */
function macSystemName(key: 'ComputerName' | 'LocalHostName'): string | null {
  if (process.platform !== 'darwin') return null;
  try {
    const out = execFileSync('/usr/sbin/scutil', ['--get', key], { encoding: 'utf8', timeout: 2000 }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Human-readable instance name. On macOS the ComputerName ("kelong 的 MacBook
 * Pro") — os.hostname() there is whatever reverse DNS said (often "bogon").
 */
export function defaultDesktopName(): string {
  const mac = macSystemName('ComputerName');
  if (mac) return mac.slice(0, 63);
  const host = hostname().replace(/\.local\.?$/i, '').replace(/-/g, ' ').trim() || 'Tabby';
  let user = '';
  try {
    user = userInfo().username;
  } catch {
    /* no user info in some sandboxes */
  }
  return (user ? `${user} 的 ${host}` : host).slice(0, 63);
}

/** `.local` host name for the SRV target; on macOS the one mDNSResponder already answers for. */
export function defaultMdnsHost(): string {
  const base = macSystemName('LocalHostName') ?? hostname().replace(/\.local\.?$/i, '').split('.')[0];
  const label = base.replace(/[^A-Za-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'tabby';
  return `${label}.local`;
}

export function buildTxtRecord(opts: { desktopId: string; name: string }): Record<string, string> {
  return {
    v: '1',
    kind: 'tabby',
    name: opts.name,
    id: opts.desktopId,
    pair: PAIR_PATH,
  };
}

export interface LanAdvertiser {
  stop(): Promise<void>;
}

export function startLanAdvertiser(opts: {
  port: number;
  desktopId: string;
  name?: string;
  logger: { info(msg: string): void; warn(msg: string): void };
}): LanAdvertiser {
  const name = opts.name ?? defaultDesktopName();
  const bonjour = new Bonjour({}, (err: unknown) => {
    opts.logger.warn(`[tabby-control] mDNS error: ${err instanceof Error ? err.message : String(err)}`);
  });
  const service = bonjour.publish({
    name,
    type: SERVICE_TYPE,
    protocol: 'tcp',
    port: opts.port,
    host: defaultMdnsHost(),
    txt: buildTxtRecord({ desktopId: opts.desktopId, name }),
  });
  service.on('up', () => {
    opts.logger.info(`[tabby-control] mDNS: advertising _itabby._tcp "${service.name}" on port ${opts.port}`);
  });
  service.on('error', (err: unknown) => {
    opts.logger.warn(`[tabby-control] mDNS publish failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  let stopped: Promise<void> | null = null;
  return {
    stop() {
      stopped ??= new Promise<void>((resolve) => {
        const done = () => {
          try {
            bonjour.destroy();
          } catch {
            /* ignore */
          }
          resolve();
        };
        const timer = setTimeout(done, 1000);
        timer.unref?.();
        try {
          bonjour.unpublishAll(() => {
            clearTimeout(timer);
            done();
          });
        } catch {
          clearTimeout(timer);
          done();
        }
      });
      return stopped;
    },
  };
}
