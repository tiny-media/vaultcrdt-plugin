import { requestUrl } from 'obsidian';
import { toHttpBase } from './url-policy';

/** Feature flags the server advertises via GET /health ("features": [...]). */
export const FEATURE_INVITE = 'invite';
export const FEATURE_DEVICE_KEYS = 'device_keys';
/** Attachment blob upload/download lane (design §3/§4). */
export const FEATURE_BLOBS = 'blobs';

/** How long a fetched feature list stays valid before we re-probe /health. */
export const FEATURES_TTL_MS = 5 * 60 * 1000;

/**
 * Upper bound for one /health probe. Obsidian's requestUrl has no timeout of
 * its own: without this, a single hung request makes every await get() — and
 * therefore every blobsEnabled() / upload attempt — hang forever while the
 * WebSocket note lane keeps working.
 */
export const FEATURES_PROBE_TIMEOUT_MS = 10_000;

/**
 * Per-plugin cache of the server's /health feature list.
 *
 * Old servers do not send "features" at all, and unreachable servers must not
 * block onboarding — both cases resolve to an empty list, which makes every
 * caller fall back to today's secret-paste behaviour.
 */
export class ServerFeatureCache {
  private entry: { key: string; features: string[]; at: number } | null = null;
  /** protocol_version from the last successful /health probe (status panel). */
  private lastProtocolVersion: number | undefined;
  /** Timestamp of the last failed/timed-out probe (failure→success is observable). */
  private lastErrorAtMs: number | null = null;

  constructor(private now: () => number = () => Date.now()) {}

  async get(serverUrl: string): Promise<string[]> {
    const key = toHttpBase(serverUrl);
    if (this.entry && this.entry.key === key && this.now() - this.entry.at < FEATURES_TTL_MS) {
      return this.entry.features;
    }
    let features: string[] = [];
    try {
      const resp = await withTimeout(
        requestUrl({ url: `${key}/health`, method: 'GET' }),
        FEATURES_PROBE_TIMEOUT_MS,
      );
      const body = resp.json as { features?: unknown; protocol_version?: unknown } | undefined;
      const raw = body?.features;
      if (Array.isArray(raw)) features = raw.filter((f): f is string => typeof f === 'string');
      if (typeof body?.protocol_version === 'number') this.lastProtocolVersion = body.protocol_version;
    } catch {
      // A transient failure must not pose as an authoritative empty list: keep
      // the last-known-good entry (stale beats empty for gating) and do NOT
      // write a fresh positive entry, so the next call re-probes immediately.
      this.lastErrorAtMs = this.now();
      return this.entry && this.entry.key === key ? this.entry.features : [];
    }
    this.lastErrorAtMs = null;
    this.entry = { key, features, at: this.now() };
    return features;
  }

  /** Timestamp of the last failed probe, or null if the last probe succeeded. */
  lastErrorAt(): number | null {
    return this.lastErrorAtMs;
  }

  /** Cached server protocol version, or undefined if never probed successfully. */
  protocolVersion(): number | undefined {
    return this.lastProtocolVersion;
  }

  /** Drop the cached list (e.g. after the user points at a different server). */
  clear(): void {
    this.entry = null;
  }
}

/** Resolve with `p`, or reject once `ms` elapsed (timer cleared either way). */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error('health probe timed out')); }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
