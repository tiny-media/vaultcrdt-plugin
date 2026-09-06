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

  constructor(private now: () => number = () => Date.now()) {}

  async get(serverUrl: string): Promise<string[]> {
    const key = toHttpBase(serverUrl);
    if (this.entry && this.entry.key === key && this.now() - this.entry.at < FEATURES_TTL_MS) {
      return this.entry.features;
    }
    let features: string[] = [];
    try {
      const resp = await requestUrl({ url: `${key}/health`, method: 'GET' });
      const body = resp.json as { features?: unknown; protocol_version?: unknown } | undefined;
      const raw = body?.features;
      if (Array.isArray(raw)) features = raw.filter((f): f is string => typeof f === 'string');
      if (typeof body?.protocol_version === 'number') this.lastProtocolVersion = body.protocol_version;
    } catch {
      features = [];
    }
    this.entry = { key, features, at: this.now() };
    return features;
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
