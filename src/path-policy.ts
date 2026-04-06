/**
 * Central sync path policy — only .md files in safe vault-relative paths.
 * Applied at all entry points (local events + remote messages) to prevent
 * non-markdown files, .obsidian internals, and path traversal from entering sync.
 */

const BLOCKED_PREFIXES = ['.obsidian/', '.trash/'];
const BLOCKED_SEGMENTS = ['..', '.'];

export function isSyncablePath(path: string): boolean {
  if (!path || typeof path !== 'string') return false;

  // Must be .md
  if (!path.endsWith('.md')) return false;

  // No absolute paths
  if (path.startsWith('/')) return false;

  // No blocked prefixes
  for (const prefix of BLOCKED_PREFIXES) {
    if (path.startsWith(prefix)) return false;
  }

  // No traversal or degenerate segments
  const segments = path.split('/');
  for (const seg of segments) {
    if (seg === '' || BLOCKED_SEGMENTS.includes(seg)) return false;
  }

  return true;
}
