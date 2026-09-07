import { normalizePath } from 'obsidian';
import { UPLOAD_DEBOUNCE_MS } from './blob-uploader';
import type { BlobIndex } from './blob-index';
import type { BlobDownloader } from './blob-downloader';
import {
  obsidianSyncCategory,
  obsidianSyncCategoryOf,
  type ObsidianSyncCategory,
  type ObsidianSyncEnabled,
} from './path-policy';

export interface ListedDir {
  files: string[];
  folders: string[];
}

export interface ObsidianSyncDeps {
  index: BlobIndex;
  downloader: BlobDownloader;
  enabled: () => ObsidianSyncEnabled;
  vaultBasePath: () => string;
  list: (dir: string) => Promise<ListedDir>;
  stat: (path: string) => Promise<{ size: number; mtime?: number } | null>;
  onFileChanged: (path: string) => void;
  onFileDeleted: (path: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Map a `vault.on('raw')` path (absolute or vault-relative; may use `\\`)
 * to a vault-relative display path. `normalizePath()` FIRST so the
 * backslash-in-segment reject does not drop legitimate Windows events.
 */
export function vaultRelativeRawPath(raw: string, basePath: string): string {
  const normalized = normalizePath(raw);
  const base = basePath ? normalizePath(basePath).replace(/\/$/, '') : '';
  if (base) {
    if (normalized === base) return '';
    const prefix = `${base}/`;
    if (normalized.startsWith(prefix)) return normalized.slice(prefix.length);
    if (normalized.toLocaleLowerCase('en-US').startsWith(prefix.toLocaleLowerCase('en-US'))) {
      return normalized.slice(prefix.length);
    }
  }
  return normalized;
}

export function joinListed(dir: string, entry: string): string {
  const e = entry.replace(/\\/g, '/').replace(/\/+$/, '');
  const d = dir.replace(/\\/g, '/').replace(/\/+$/, '');
  if (e === d || e.startsWith(`${d}/`)) return e;
  const name = e.includes('/') ? e.slice(e.lastIndexOf('/') + 1) : e;
  return `${d}/${name}`;
}

/**
 * Undocumented Vault event: fires for adapter-level writes, including
 * `.obsidian/**`. Firing is NOT guaranteed — the backstop sweep is required,
 * not optional. obsidian.d.ts only types create/modify/delete/rename.
 */
export type VaultRawHandler = (path: string) => void;

export function listenVaultRaw(vault: unknown, handler: VaultRawHandler): unknown {
  // Documented cast: obsidian.d.ts only types create/modify/delete/rename.
  return (vault as { on(name: 'raw', cb: VaultRawHandler): unknown }).on('raw', handler);
}

async function safeList(
  list: (dir: string) => Promise<ListedDir>,
  dir: string,
): Promise<ListedDir> {
  try {
    return await list(dir);
  } catch {
    return { files: [], folders: [] };
  }
}

/** Backstop discovery: adapter.list of .obsidian, snippets, themes (+ each theme dir). */
export async function listObsidianCategoryFiles(
  list: (dir: string) => Promise<ListedDir>,
  enabled: ObsidianSyncEnabled,
): Promise<string[]> {
  const out: string[] = [];
  if (!enabled.settings && !enabled.styles) return out;

  const root = await safeList(list, '.obsidian');
  if (enabled.settings) {
    for (const f of root.files) {
      const path = joinListed('.obsidian', f);
      if (obsidianSyncCategory(path, enabled) === 'settings') out.push(path);
    }
  }

  if (!enabled.styles) return out;

  const snippets = await safeList(list, '.obsidian/snippets');
  for (const f of snippets.files) {
    const path = joinListed('.obsidian/snippets', f);
    if (obsidianSyncCategory(path, enabled) === 'styles') out.push(path);
  }

  const themes = await safeList(list, '.obsidian/themes');
  for (const folder of themes.folders) {
    const themeDir = joinListed('.obsidian/themes', folder);
    const listed = await safeList(list, themeDir);
    for (const f of listed.files) {
      const path = joinListed(themeDir, f);
      if (obsidianSyncCategory(path, enabled) === 'styles') out.push(path);
    }
  }
  return out;
}

/**
 * Adapter-based .obsidian lane: raw-listener debounce + backstop sweep +
 * toggle-on hydrate-then-sweep. Bytes still go through the blob uploader.
 */
export class ObsidianSync {
  private pendingRaw = new Set<string>();
  private rawFlush: Promise<void> | null = null;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private deps: ObsidianSyncDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => { window.setTimeout(r, ms); }));
  }

  onRaw(raw: string): void {
    const path = vaultRelativeRawPath(raw, this.deps.vaultBasePath());
    if (!obsidianSyncCategory(path, this.deps.enabled())) return;
    this.pendingRaw.add(path);
    void this.flushRaw();
  }

  private async flushRaw(): Promise<void> {
    if (this.rawFlush) return this.rawFlush;
    const run = (async () => {
      await this.sleep(UPLOAD_DEBOUNCE_MS);
      const paths = [...this.pendingRaw];
      this.pendingRaw.clear();
      this.rawFlush = null;
      for (const p of paths) this.deps.onFileChanged(p);
    })();
    this.rawFlush = run;
    return run;
  }

  async flush(): Promise<void> {
    if (this.rawFlush) await this.rawFlush;
  }

  /**
   * Diff adapter listing against the blob index. New/changed → upload check.
   * Gone entries are tombstoned via onFileDeleted only when hydrated && !skipped
   * (unhydrated second-device rows must not be pushed as deletes).
   */
  async sweep(): Promise<void> {
    const enabled = this.deps.enabled();
    if (!enabled.settings && !enabled.styles) return;
    const present = await listObsidianCategoryFiles(this.deps.list, enabled);
    const presentSet = new Set(present);

    for (const path of present) {
      const st = await this.deps.stat(path);
      if (!st) continue;
      const entry = this.deps.index.get(path);
      if (
        !entry
        || entry.skipped
        || entry.size !== st.size
        || (entry.mtime != null && st.mtime != null && entry.mtime !== st.mtime)
      ) {
        this.deps.onFileChanged(path);
      }
    }

    for (const [path, entry] of this.deps.index.entries()) {
      if (obsidianSyncCategory(path, enabled) === null) continue;
      if (presentSet.has(path)) continue;
      if (entry.hydrated && !entry.skipped) {
        await this.deps.onFileDeleted(path);
      }
    }
  }

  /** Toggle-ON: hydrate skipped/unhydrated category entries FIRST, then sweep. */
  async onCategoryEnabled(category: ObsidianSyncCategory): Promise<void> {
    const toHydrate: string[] = [];
    for (const [path, entry] of this.deps.index.entries()) {
      if (obsidianSyncCategoryOf(path) !== category) continue;
      if (!entry.skipped && entry.hydrated) continue;
      toHydrate.push(path);
    }
    for (const path of toHydrate) {
      this.deps.index.update(path, { skipped: false });
      await this.deps.downloader.hydrateOne(path);
    }
    await this.sweep();
  }
}
