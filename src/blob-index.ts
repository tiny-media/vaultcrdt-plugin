import { blob_path_key } from '../wasm/vaultcrdt_wasm';

/**
 * Persistent attachment blob index (design §3). One entry per attachment path,
 * keyed by the vault-relative path; `key` is the canonical blob path key from
 * the WASM `blob_path_key` (paths without a key are not attachments and are
 * never indexed).
 *
 * Lives in plugin state (`state/blob-index.json`) like the inbox, so the
 * diagnostics export — which dumps settings verbatim — never sees it.
 */
export interface BlobIndexEntry {
  /** Canonical blob path key (key_version 1). */
  key: string;
  /** BLAKE3 hex of the bytes last hashed locally. */
  hash: string;
  size: number;
  generation: number;
  /** Server seq of the last accepted blob-path state. */
  seq: number;
  /** False when the server advertises content this device has not downloaded. */
  hydrated: boolean;
  /** Hash last confirmed by the server for this path — echo suppression. */
  lastRemoteHash: string;
  /** Set when the file exceeded the type cap and was never read. */
  skipped?: boolean;
}

interface BlobIndexFile {
  v: 1;
  maxSeq: number;
  paths: Record<string, BlobIndexEntry>;
}

export interface BlobIndexStorage {
  loadJson<T>(name: string): Promise<T | null>;
  saveJson(name: string, value: unknown): Promise<void>;
}

export const BLOB_INDEX_FILE = 'blob-index.json';

function parse(raw: unknown): BlobIndexFile {
  const file = raw as Partial<BlobIndexFile> | null;
  const empty: BlobIndexFile = { v: 1, maxSeq: 0, paths: {} };
  if (!file || file.v !== 1 || !file.paths || typeof file.paths !== 'object') return empty;
  for (const [path, e] of Object.entries(file.paths)) {
    if (!e || typeof e.key !== 'string' || typeof e.hash !== 'string') continue;
    empty.paths[path] = {
      key: e.key,
      hash: e.hash,
      size: typeof e.size === 'number' ? e.size : 0,
      generation: typeof e.generation === 'number' ? e.generation : 0,
      seq: typeof e.seq === 'number' ? e.seq : 0,
      hydrated: e.hydrated !== false,
      lastRemoteHash: typeof e.lastRemoteHash === 'string' ? e.lastRemoteHash : '',
      ...(e.skipped ? { skipped: true } : {}),
    };
  }
  empty.maxSeq = typeof file.maxSeq === 'number' ? file.maxSeq : 0;
  return empty;
}

export class BlobIndex {
  private file: BlobIndexFile = { v: 1, maxSeq: 0, paths: {} };
  private writes: Promise<void> = Promise.resolve();

  constructor(private storage: BlobIndexStorage) {}

  async load(): Promise<void> {
    this.file = parse(await this.storage.loadJson<BlobIndexFile>(BLOB_INDEX_FILE));
  }

  /** Canonical key, or null when the path is not a syncable attachment. */
  keyFor(path: string): string | null {
    return blob_path_key(path) ?? null;
  }

  get(path: string): BlobIndexEntry | undefined {
    return this.file.paths[path];
  }

  /** First path whose entry carries this blob path key. */
  pathForKey(key: string): string | undefined {
    for (const [path, e] of Object.entries(this.file.paths)) if (e.key === key) return path;
    return undefined;
  }

  /**
   * Merge `patch` into the entry for `path`. Returns null (and writes nothing)
   * when the path has no blob path key.
   */
  update(path: string, patch: Partial<BlobIndexEntry>): BlobIndexEntry | null {
    const key = this.keyFor(path);
    if (!key) return null;
    const prev: BlobIndexEntry = this.file.paths[path]
      ?? { key, hash: '', size: 0, generation: 0, seq: 0, hydrated: true, lastRemoteHash: '' };
    const next: BlobIndexEntry = { ...prev, ...patch, key };
    this.file.paths[path] = next;
    if (next.seq > this.file.maxSeq) this.file.maxSeq = next.seq;
    this.persist();
    return next;
  }

  /** Highest server seq observed (per-path acks and catch-up pages). */
  maxSeq(): number {
    return this.file.maxSeq;
  }

  noteMaxSeq(seq: number): void {
    if (seq <= this.file.maxSeq) return;
    this.file.maxSeq = seq;
    this.persist();
  }

  private persist(): void {
    const snapshot: BlobIndexFile = {
      v: 1,
      maxSeq: this.file.maxSeq,
      paths: Object.fromEntries(Object.entries(this.file.paths).map(([p, e]) => [p, { ...e }])),
    };
    this.writes = this.writes
      .then(() => this.storage.saveJson(BLOB_INDEX_FILE, snapshot))
      .catch(() => undefined);
  }

  /** Await pending writes (tests / shutdown). */
  async flush(): Promise<void> {
    await this.writes;
  }
}
