import type { StateStorage } from './state-storage';
import { warn } from './logger';

export const OWNERSHIP_CACHE_FILE = 'ownership-cache.json';
export function nextRequestId(): string { return crypto.randomUUID(); }

/** Only correlated write Acks grant ownership. Observations MUST NOT call grant. */
export class OwnershipCache {
  readonly ownedTokens = new Map<string, number>();
  readonly pendingGrants = new Map<string, string>();
  private writes: Promise<void> = Promise.resolve();

  constructor(private storage: Pick<StateStorage, 'readRaw' | 'saveJson'>) {}

  async load(): Promise<void> {
    await this.writes;
    this.ownedTokens.clear();
    try {
      const raw = await this.storage.readRaw(OWNERSHIP_CACHE_FILE);
      if (raw === null) throw new Error('missing ownership cache');
      const entries: unknown = JSON.parse(raw);
      if (!Array.isArray(entries) || !entries.every(e =>
        e && typeof e.path === 'string' && typeof e.token === 'number' && Number.isFinite(e.token),
      )) throw new Error('corrupt ownership cache');
      for (const { path, token } of entries) this.ownedTokens.set(path, token);
    } catch (err) {
      warn('[VCRDT] ownership cache unavailable; resolving deletes instead', { err });
    }
  }

  track(requestId: string, path: string): void {
    this.pendingGrants.set(requestId, path);
    if (this.pendingGrants.size > 256) this.pendingGrants.delete(this.pendingGrants.keys().next().value!);
  }

  forgetRequest(requestId: unknown): string | undefined {
    if (typeof requestId !== 'string') return undefined;
    const path = this.pendingGrants.get(requestId);
    this.pendingGrants.delete(requestId);
    return path;
  }

  grant(requestId: unknown, incarnation: unknown): Promise<void> {
    const path = this.forgetRequest(requestId);
    if (path === undefined || typeof incarnation !== 'number' || !Number.isFinite(incarnation)) return Promise.resolve();
    this.ownedTokens.set(path, incarnation);
    return this.persist();
  }

  remove(path: string): Promise<void> {
    this.ownedTokens.delete(path);
    return this.persist();
  }

  reconcile(live: ReadonlySet<string>): Promise<void> {
    for (const path of this.ownedTokens.keys()) if (!live.has(path)) this.ownedTokens.delete(path);
    return this.persist();
  }

  private persist(): Promise<void> {
    const entries = [...this.ownedTokens].map(([path, token]) => ({ path, token }));
    const write = this.writes.then(() => this.storage.saveJson(OWNERSHIP_CACHE_FILE, entries));
    this.writes = write.catch(() => {});
    return write;
  }
}
