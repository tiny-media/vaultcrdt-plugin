/**
 * Central URL validation and normalisation for the server endpoint.
 *
 * Rationale: we used to do substring checks like `url.includes('localhost')`,
 * which accepts `http://localhost.evil.com` and `http://x/?next=localhost`.
 * Every entry point (SetupModal, Settings, SyncEngine) must now go through
 * this module so plain HTTP/WS can only reach actual loopback or RFC1918 LAN
 * addresses.
 */

export type UrlValidation =
  | { ok: true; url: URL }
  | { ok: false; reason: string };

const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:']);
const INSECURE_SCHEMES = new Set(['http:', 'ws:']);

/**
 * Validate a user-supplied server URL.
 * Accepts: https/wss anywhere, http/ws only for localhost / 127.0.0.1 / ::1 /
 * RFC1918 private networks (10/8, 172.16/12, 192.168/16).
 */
export function validateServerUrl(raw: string): UrlValidation {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: 'Server URL is required' };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'Not a valid URL (expected e.g. https://sync.example.com)' };
  }

  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    return {
      ok: false,
      reason: `Unsupported scheme "${url.protocol}". Use https://, wss://, or http(s)://localhost for local testing.`,
    };
  }

  if (INSECURE_SCHEMES.has(url.protocol) && !isLocalOrPrivateHost(url.hostname)) {
    return {
      ok: false,
      reason:
        'Insecure connection (no TLS). Use https:// or wss:// — plain http/ws is only allowed for localhost or a private LAN address.',
    };
  }

  return { ok: true, url };
}

/** True if `hostname` is loopback or an RFC1918 private IPv4 address. */
export function isLocalOrPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
    return true;
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n < 0 || n > 255)) return false;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/** Convert a validated server URL to the HTTP(S) base for REST calls. */
export function toHttpBase(raw: string): string {
  return raw.trim().replace(/^ws:\/\//i, 'http://').replace(/^wss:\/\//i, 'https://');
}

/** Convert a validated server URL to the WS(S) base for the /ws endpoint. */
export function toWsBase(raw: string): string {
  return raw.trim().replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://');
}
