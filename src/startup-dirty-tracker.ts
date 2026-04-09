interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const STORAGE_PREFIX = 'vaultcrdt:startup-dirty:v1:';

function getBrowserStorage(): StorageLike | null {
  try {
    if (typeof globalThis.localStorage === 'undefined') return null;
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export class StartupDirtyTracker {
  private storage: StorageLike | null;
  private paths = new Set<string>();

  constructor(
    vaultId: string,
    peerId: string,
    storage: StorageLike | null = getBrowserStorage(),
  ) {
    this.storage = storage;
    this.key = `${STORAGE_PREFIX}${encodeURIComponent(vaultId)}:${encodeURIComponent(peerId)}`;
    this.reload();
  }

  private key: string;

  reload(): void {
    if (!this.storage) {
      this.paths.clear();
      return;
    }
    try {
      const raw = this.storage.getItem(this.key);
      if (!raw) {
        this.paths.clear();
        return;
      }
      const obj = JSON.parse(raw) as { _version?: number; paths?: unknown };
      if (obj._version !== 1 || !Array.isArray(obj.paths)) {
        this.paths.clear();
        return;
      }
      this.paths = new Set(obj.paths.filter((p): p is string => typeof p === 'string'));
    } catch {
      this.paths.clear();
    }
  }

  snapshot(): Set<string> {
    return new Set(this.paths);
  }

  size(): number {
    return this.paths.size;
  }

  has(path: string): boolean {
    return this.paths.has(path);
  }

  markDirty(path: string): void {
    if (this.paths.has(path)) return;
    this.paths.add(path);
    this.persist();
  }

  clear(path: string): void {
    if (!this.paths.delete(path)) return;
    this.persist();
  }

  replace(paths: Iterable<string>): void {
    this.paths = new Set(paths);
    this.persist();
  }

  clearAll(): void {
    this.paths.clear();
    if (!this.storage) return;
    try {
      this.storage.removeItem(this.key);
    } catch {
      // ignore
    }
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      if (this.paths.size === 0) {
        this.storage.removeItem(this.key);
        return;
      }
      this.storage.setItem(this.key, JSON.stringify({
        _version: 1,
        paths: [...this.paths].sort(),
      }));
    } catch {
      // ignore — local startup optimisation must not break sync
    }
  }
}
