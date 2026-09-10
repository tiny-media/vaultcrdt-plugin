import type { BlobIndex, BlobIndexEntry } from './blob-index';

export type EffectAuthority = { kind: 'upload' } | { kind: 'decision'; seq: number } |
  { kind: 'hydration'; seq: number; hash: string };
export type EffectToken = number;

/** Shared write lifetime registry. Locks never acquire the decision lane. */
export class PathEffects {
  private next = 0;
  private effects = new Map<number, { path: string; authority: EffectAuthority; captured?: BlobIndexEntry }>();
  private cancelled = new Set<number>();
  private locks = new Map<string, Promise<unknown>>();
  private selfDeletes = new Map<string, number>();

  constructor(private index: BlobIndex, private trash: (path: string) => Promise<void>,
    private superseded: (path: string) => boolean = () => false,
    private onSettlement: (path: string) => void = () => {}) {}

  async withPathLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const work = (this.locks.get(path) ?? Promise.resolve()).catch(() => {}).then(fn);
    this.locks.set(path, work);
    try { return await work; }
    finally { if (this.locks.get(path) === work) this.locks.delete(path); }
  }

  register(path: string, authority: EffectAuthority): EffectToken {
    const token = ++this.next;
    const entry = this.index.get(path);
    this.effects.set(token, { path, authority, captured: entry ? { ...entry } : undefined });
    return token;
  }
  settle(token: EffectToken): void {
    const effect = this.effects.get(token);
    this.effects.delete(token);
    this.cancelled.delete(token);
    if (effect) this.onSettlement(effect.path);
  }
  cancelByPath(path: string, filter: (authority: EffectAuthority) => boolean = () => true): void {
    for (const [token, effect] of this.effects) {
      if (effect.path === path && filter(effect.authority)) this.cancelled.add(token);
    }
  }
  pending(path: string): boolean {
    return [...this.effects.values()].some((effect) => effect.path === path);
  }
  isCancelled(token: EffectToken): boolean { return this.cancelled.has(token); }
  consumeSelfDelete(path: string): boolean {
    const until = this.selfDeletes.get(path);
    this.selfDeletes.delete(path);
    return until !== undefined && until > Date.now();
  }

  /** Called while holding the write's uninterrupted lock, after writeBinary. */
  classify(token: EffectToken): 'normal' | 'supersession' | 'stop' | Promise<'cancellation'> {
    const effect = this.effects.get(token);
    if (!effect) throw new Error('Unknown path effect');
    const { path, authority, captured } = effect;
    const current = this.index.get(path);
    if (this.cancelled.has(token)) return this.compensate(path);
    if (authority.kind === 'upload') return this.superseded(path) ? 'stop' : 'normal';
    if (!current) return this.compensate(path);
    if (current && (current.seq > Math.max(authority.seq, captured?.seq ?? 0) ||
      (authority.kind === 'hydration' && current.hash !== authority.hash))) {
      this.index.update(path, { hydrated: false });
      return 'supersession';
    }
    return 'normal';
  }

  private async compensate(path: string): Promise<'cancellation'> {
    const until = Date.now() + 5000;
    this.selfDeletes.set(path, until);
    const timer = setTimeout(() => {
      if (this.selfDeletes.get(path) === until) this.selfDeletes.delete(path);
    }, 5000);
    // Node tests must not stay alive for the echo expiry; browsers return a number.
    (timer as unknown as { unref?: () => void }).unref?.();
    try { await this.trash(path); }
    catch (error) {
      if (this.selfDeletes.get(path) === until) this.selfDeletes.delete(path);
      throw error;
    }
    return 'cancellation';
  }
}
