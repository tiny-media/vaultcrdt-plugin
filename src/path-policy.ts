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
const ATTACHMENT_EXTENSIONS = [
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif', 'avif',
  'pdf', 'mp3', 'm4a', 'ogg', 'opus', 'flac', 'wav',
];

/**
 * Cheap gate for routing attachment events. Structure rules mirror
 * isSyncablePath; the canonical key (NFC + casefold) is the Rust
 * blob_path_key — deliberately NOT replicated here.
 */
export function isAttachmentPath(path: string): boolean {
  if (!path || typeof path !== 'string') return false;
  if (path.startsWith('/')) return false;

  const pathKey = pathCaseKey(path);
  for (const prefix of BLOCKED_PREFIXES) {
    if (pathKey.startsWith(pathCaseKey(prefix))) return false;
  }

  for (const seg of path.split('/')) {
    if (seg === '' || BLOCKED_SEGMENTS.includes(seg)) return false;
    if (seg.endsWith(' ') || seg.endsWith('.')) return false;
  }

  const dot = pathKey.lastIndexOf('.');
  if (dot < 0) return false;
  return ATTACHMENT_EXTENSIONS.includes(pathKey.slice(dot + 1));
}

const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'ogg', 'opus', 'flac', 'wav'];
const MIB = 1024 * 1024;

/**
 * Per-type upload size cap (design §3): images/pdf 10 MiB, audio 25 MiB.
 * Returns 0 for paths that are not attachments at all.
 */
export function attachmentCap(path: string): number {
  if (!isAttachmentPath(path)) return 0;
  const ext = pathCaseKey(path).slice(pathCaseKey(path).lastIndexOf('.') + 1);
  return AUDIO_EXTENSIONS.includes(ext) ? 25 * MIB : 10 * MIB;
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
  }

  return true;
}
