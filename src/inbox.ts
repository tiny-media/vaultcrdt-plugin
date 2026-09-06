import { INBOX_COPY } from './user-facing-copy';

/**
 * Quiet-mode inbox (design §E/§F): events that used to interrupt with a 12/15 s
 * Notice are collected here instead. Persisted in `state/inbox.json` — never in
 * settings, because the diagnostics export dumps settings verbatim.
 */
export type InboxKind =
  | 'conflict'
  | 'deleted-remote'
  | 'tombstone-edit'
  | 'tombstone-rename'
  | 'disjoint-conflict'
  | 'failed-docs';

/** Kinds whose entry is tied to a vault file: gone file → entry auto-clears. */
const FILE_KINDS: ReadonlySet<InboxKind> = new Set<InboxKind>([
  'conflict',
  'disjoint-conflict',
  'deleted-remote',
  'tombstone-rename',
]);

export interface InboxEntry {
  id: string;
  kind: InboxKind;
  /** The path the entry is about — for conflicts the conflict copy. */
  path: string;
  /** Counterpart path (original file for conflicts, renamed target, …). */
  relatedPath?: string;
  createdAt: number;
  note?: string;
}

export interface InboxFile {
  v: 1;
  items: InboxEntry[];
}

/** Minimal write surface used by the sync engine / initial sync. */
export interface InboxSink {
  add(entry: Omit<InboxEntry, 'id' | 'createdAt'>): void;
}

export interface InboxDeps {
  storage: {
    loadJson<T>(name: string): Promise<T | null>;
    saveJson(name: string, value: unknown): Promise<void>;
  };
  /** True when the vault still has a file at this path. */
  fileExists(path: string): boolean;
  /** Shows the throttled discovery notice. */
  notify(text: string): void;
  now?: () => number;
}

export const INBOX_FILE = 'inbox.json';
/** One discovery notice per 5 minutes per session (design §E). */
export const DISCOVERY_THROTTLE_MS = 5 * 60_000;
/** Files matching this marker are conflict copies created by VaultCRDT. */
const CONFLICT_MARKER = '(conflict';
/** Files matching this marker are kept copies of remotely deleted docs. */
const DELETED_REMOTE_MARKER = '(deleted-remote';

export function isConflictCopyPath(path: string): boolean {
  return path.includes(CONFLICT_MARKER);
}

export function isDeletedRemoteCopyPath(path: string): boolean {
  return path.includes(DELETED_REMOTE_MARKER);
}

function parseInbox(raw: unknown): InboxEntry[] {
  const file = raw as Partial<InboxFile> | null;
  if (!file || file.v !== 1 || !Array.isArray(file.items)) return [];
  return file.items.filter(
    (e): e is InboxEntry =>
      !!e && typeof e.id === 'string' && typeof e.path === 'string' && typeof e.kind === 'string',
  );
}

export class Inbox implements InboxSink {
  private items: InboxEntry[] = [];
  private lastNoticeAt = 0;
  private seq = 0;
  private writes: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(private deps: InboxDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** Load from disk and drop entries whose file is gone. */
  async load(): Promise<void> {
    this.items = parseInbox(await this.deps.storage.loadJson<InboxFile>(INBOX_FILE));
    this.reconcileAll();
    this.persist();
  }

  list(): readonly InboxEntry[] {
    return this.items;
  }

  /** Visible count: file-kind entries whose file still exists + all others. */
  count(): number {
    return this.items.length;
  }

  add(entry: Omit<InboxEntry, 'id' | 'createdAt'>): void {
    const createdAt = this.now();
    const duplicate = this.items.some(
      (e) => e.kind === entry.kind && e.path === entry.path && e.relatedPath === entry.relatedPath,
    );
    if (duplicate) return;
    this.seq += 1;
    this.items.push({ ...entry, id: `${createdAt}-${this.seq}`, createdAt });
    this.persist();
    this.maybeNotify();
  }

  dismiss(id: string): void {
    const before = this.items.length;
    this.items = this.items.filter((e) => e.id !== id);
    if (this.items.length !== before) this.persist();
  }

  /** Vault delete: an entry whose file is gone is resolved. */
  onFileDeleted(path: string): void {
    this.dropWhere((e) => FILE_KINDS.has(e.kind) && e.path === path);
  }

  /**
   * Vault rename: a conflict copy renamed away from the `(conflict` pattern
   * and a kept deleted-remote copy renamed away from `(deleted-remote` count
   * as handled; a rename that keeps the pattern just moves the entry.
   */
  onFileRenamed(oldPath: string, newPath: string): void {
    let changed = false;
    const kept: InboxEntry[] = [];
    for (const e of this.items) {
      if (!FILE_KINDS.has(e.kind) || e.path !== oldPath) { kept.push(e); continue; }
      changed = true;
      const stillPattern = e.kind === 'conflict' || e.kind === 'disjoint-conflict'
        ? isConflictCopyPath(newPath)
        : e.kind === 'tombstone-rename'
          ? isDeletedRemoteCopyPath(newPath)
          : true;
      if (stillPattern) kept.push({ ...e, path: newPath });
    }
    this.items = kept;
    if (changed) this.persist();
  }

  /**
   * Startup scan: adopt pre-existing `(conflict` copies that have no entry yet
   * (e.g. created by an older plugin version) and drop stale file entries.
   */
  scanExisting(paths: readonly string[]): void {
    this.reconcileAll();
    const known = new Set(this.items.map((e) => e.path));
    for (const path of paths) {
      if (!isConflictCopyPath(path) || known.has(path)) continue;
      this.seq += 1;
      this.items.push({
        id: `scan-${this.now()}-${this.seq}`, kind: 'conflict', path, createdAt: this.now(),
        note: INBOX_COPY.scanNote,
      });
    }
    this.persist();
  }

  private reconcileAll(): void {
    this.items = this.items.filter((e) => !FILE_KINDS.has(e.kind) || this.deps.fileExists(e.path));
  }

  private dropWhere(pred: (e: InboxEntry) => boolean): void {
    const before = this.items.length;
    this.items = this.items.filter((e) => !pred(e));
    if (this.items.length !== before) this.persist();
  }

  private maybeNotify(): void {
    const t = this.now();
    if (t - this.lastNoticeAt < DISCOVERY_THROTTLE_MS) return;
    this.lastNoticeAt = t;
    this.deps.notify(INBOX_COPY.discovery);
  }

  private persist(): void {
    const snapshot: InboxFile = { v: 1, items: this.items.map((e) => ({ ...e })) };
    this.writes = this.writes
      .then(() => this.deps.storage.saveJson(INBOX_FILE, snapshot))
      .catch(() => undefined);
  }

  /** Await pending writes (tests / shutdown). */
  async flush(): Promise<void> {
    await this.writes;
  }
}
