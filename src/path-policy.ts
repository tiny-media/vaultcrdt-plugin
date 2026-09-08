/**
 * Central sync path policy — only .md files in safe vault-relative paths.
 * Applied at all entry points (local events + remote messages) to prevent
 * non-markdown files, .obsidian internals, and path traversal from entering sync.
 */

const BLOCKED_PREFIXES = ['.obsidian/', '.trash/'];
const BLOCKED_SEGMENTS = ['..', '.'];

export function pathCaseKey(path: string): string {
  return path.toLocaleLowerCase('en-US');
}

export function isCaseOnlyPathRename(oldPath: string, newPath: string): boolean {
  return oldPath !== newPath && pathCaseKey(oldPath) === pathCaseKey(newPath);
}

/**
 * Attachment extensions eligible for blob sync (lowercase, without dot).
 * Must stay in sync with ATTACHMENT_EXTENSIONS in crates/vaultcrdt-core/src/blob_path.rs.
 */
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif', 'avif', 'svg'];
const PDF_EXTENSIONS = ['pdf'];
const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'ogg', 'oga', 'opus', 'flac', 'wav', 'webm', '3gp'];
const ATTACHMENT_EXTENSIONS = [...IMAGE_EXTENSIONS, ...PDF_EXTENSIONS, ...AUDIO_EXTENSIONS];

/** Per-device .obsidian blob-lane categories (defaults OFF). */
export interface ObsidianSyncEnabled {
  settings: boolean;
  styles: boolean;
}

export const OBSIDIAN_SYNC_OFF: ObsidianSyncEnabled = { settings: false, styles: false };

export type ObsidianSyncCategory = 'settings' | 'styles';

const MIB = 1024 * 1024;
const IMAGE_CAP = 10 * MIB;
const PDF_CAP = 10 * MIB;
const AUDIO_CAP = 25 * MIB;
/** Category files (.obsidian json/css) — 2 MiB. */
export const OBSIDIAN_CAP = 2 * MIB;

const SETTINGS_KEYS = new Set(['.obsidian/app.json', '.obsidian/appearance.json']);
const SNIPPETS_PREFIX = '.obsidian/snippets/';
const THEMES_PREFIX = '.obsidian/themes/';

function hasIllegalSegments(path: string): boolean {
  for (const seg of path.split('/')) {
    if (seg === '' || BLOCKED_SEGMENTS.includes(seg)) return true;
    // Windows separator inside a POSIX segment (escape into plugins/). After
    // normalizePath(), legitimate Windows events no longer contain `\\`.
    if (seg.includes('\\')) return true;
    if (seg.endsWith(' ') || seg.endsWith('.')) return true;
  }
  return false;
}

/**
 * Which .obsidian category a vault-relative display path belongs to, or null.
 * Advisory UX gate on the raw path (pathCaseKey matching). The authoritative
 * check is blob_path_key on the folded key.
 *
 * Hardcoded `.obsidian/` prefix is deliberate: Obsidian allows a custom
 * configDir, but server keys assume the standard folder name.
 *
 * Never matches workspace.json, workspace-mobile.json, or plugins/** —
 * those are hardcoded non-syncable regardless of toggles.
 */
export function obsidianSyncCategoryOf(path: string): ObsidianSyncCategory | null {
  if (!path || typeof path !== 'string') return null;
  if (path.startsWith('/')) return null;
  if (hasIllegalSegments(path)) return null;

  const pathKey = pathCaseKey(path);
  if (SETTINGS_KEYS.has(pathKey)) return 'settings';

  if (pathKey.startsWith(SNIPPETS_PREFIX)) {
    const rest = pathKey.slice(SNIPPETS_PREFIX.length);
    if (!rest.includes('/') && rest.endsWith('.css') && rest.length > '.css'.length) {
      return 'styles';
    }
    return null;
  }

  if (pathKey.startsWith(THEMES_PREFIX)) {
    const rest = pathKey.slice(THEMES_PREFIX.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) return null;
    const file = rest.slice(slash + 1);
    if (file.includes('/')) return null;
    if (file === 'theme.css' || file === 'manifest.json') return 'styles';
    return null;
  }

  return null;
}

/** Category match AND that category's per-device toggle is on. */
export function obsidianSyncCategory(
  path: string,
  enabled: ObsidianSyncEnabled = OBSIDIAN_SYNC_OFF,
): ObsidianSyncCategory | null {
  const flags = enabled ?? OBSIDIAN_SYNC_OFF;
  const cat = obsidianSyncCategoryOf(path);
  if (!cat || !flags[cat]) return null;
  return cat;
}

/**
 * Cheap gate for routing attachment events. Structure rules mirror
 * isSyncablePath; the canonical key (NFC + casefold) is the Rust
 * blob_path_key — deliberately NOT replicated here.
 */
export function isAttachmentPath(
  path: string,
  enabled: ObsidianSyncEnabled = OBSIDIAN_SYNC_OFF,
): boolean {
  if (!path || typeof path !== 'string') return false;
  if (path.startsWith('/')) return false;

  if (obsidianSyncCategory(path, enabled ?? OBSIDIAN_SYNC_OFF)) return true;

  const pathKey = pathCaseKey(path);
  for (const prefix of BLOCKED_PREFIXES) {
    if (pathKey.startsWith(pathCaseKey(prefix))) return false;
  }

  for (const seg of path.split('/')) {
    if (seg === '' || BLOCKED_SEGMENTS.includes(seg)) return false;
    if (seg.includes('\\')) return false;
    if (seg.endsWith(' ') || seg.endsWith('.')) return false;
  }

  const dot = pathKey.lastIndexOf('.');
  if (dot < 0) return false;
  return ATTACHMENT_EXTENSIONS.includes(pathKey.slice(dot + 1));
}

/**
 * Per-type upload size cap: images 10 MiB, pdf 10 MiB, audio 25 MiB,
 * .obsidian category files 2 MiB. Extension groups match the server
 * (jpg jpeg png webp gif heic heif avif svg / pdf / mp3 m4a ogg oga opus
 * flac wav webm 3gp). Returns 0 for non-attachments.
 */
export function attachmentCap(
  path: string,
  enabled: ObsidianSyncEnabled = OBSIDIAN_SYNC_OFF,
): number {
  if (obsidianSyncCategoryOf(path)) return OBSIDIAN_CAP;
  if (!isAttachmentPath(path, enabled)) return 0;
  const ext = pathCaseKey(path).slice(pathCaseKey(path).lastIndexOf('.') + 1);
  if (AUDIO_EXTENSIONS.includes(ext)) return AUDIO_CAP;
  if (PDF_EXTENSIONS.includes(ext)) return PDF_CAP;
  if (IMAGE_EXTENSIONS.includes(ext)) return IMAGE_CAP;
  return 0;
}

/**
 * Compressed Excalidraw drawings (`*.excalidraw.md`). Concurrent CRDT merges
 * interleave the LZString payload; sequential single-editor diffs are safe.
 * Blocked prefixes (`.obsidian/`, `.trash/`) win over the suffix.
 */
export function isExcalidrawPath(path: string): boolean {
  if (!path || typeof path !== 'string') return false;
  const key = pathCaseKey(path);
  for (const prefix of BLOCKED_PREFIXES) {
    if (key.startsWith(pathCaseKey(prefix))) return false;
  }
  return key === 'excalidraw.md' || key.endsWith('.excalidraw.md');
}

export function isSyncablePath(path: string): boolean {
  if (!path || typeof path !== 'string') return false;

  // Must be .md
  if (!path.endsWith('.md')) return false;

  // No absolute paths
  if (path.startsWith('/')) return false;

  // No blocked prefixes (case-insensitive — Android/Windows may surface .Obsidian)
  const pathKey = pathCaseKey(path);
  for (const prefix of BLOCKED_PREFIXES) {
    if (pathKey.startsWith(pathCaseKey(prefix))) return false;
  }

  // No traversal or degenerate segments
  const segments = path.split('/');
  for (const seg of segments) {
    if (seg === '' || BLOCKED_SEGMENTS.includes(seg)) return false;
    // Windows separator inside a POSIX segment: normalizePath() converts \ to
    // / AFTER this gate, minting real '..' segments downstream. Mirrors
    // hasIllegalSegments' rule for the server-supplied doc_uuid lane.
    if (seg.includes('\\')) return false;
  }

  return true;
}
