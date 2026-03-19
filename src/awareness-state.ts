/** Expiry window: if a peer hasn't sent a cursor update within this time, hide their cursor. */
const CURSOR_EXPIRY_MS = 5_000;

/**
 * Derive a deterministic HSL color from a peer ID string.
 * The hue is computed via a simple polynomial hash so the same peer always
 * gets the same color, and different peers (statistically) get different ones.
 */
export function peerColor(peerId: string): string {
  let hash = 0;
  for (let i = 0; i < peerId.length; i++) {
    hash = (Math.imul(hash, 31) + peerId.charCodeAt(i)) | 0;
  }
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}, 70%, 50%)`;
}

export interface CursorEntry {
  peerId: string;
  pos: number;     // character offset in the document
  color: string;   // CSS color string
  updatedAt: number; // Date.now() at last update
}

/**
 * In-memory store for remote peer cursor positions, keyed by (docPath, peerId).
 * Cursors automatically expire after CURSOR_EXPIRY_MS milliseconds of inactivity.
 */
export class CursorTracker {
  private cursors: Map<string, Map<string, CursorEntry>> = new Map();

  /** Record or refresh a peer's cursor position for a given document. */
  update(docPath: string, peerId: string, pos: number): void {
    let doc = this.cursors.get(docPath);
    if (!doc) {
      doc = new Map();
      this.cursors.set(docPath, doc);
    }
    doc.set(peerId, {
      peerId,
      pos,
      color: peerColor(peerId),
      updatedAt: Date.now(),
    });
  }

  /**
   * Return all non-expired cursors for a document, sorted ascending by pos.
   * Expired entries are pruned in place.
   */
  getActive(docPath: string): CursorEntry[] {
    const now = Date.now();
    const doc = this.cursors.get(docPath);
    if (!doc) return [];
    const active: CursorEntry[] = [];
    for (const [peerId, entry] of doc) {
      if (now - entry.updatedAt < CURSOR_EXPIRY_MS) {
        active.push(entry);
      } else {
        doc.delete(peerId);
      }
    }
    return active.sort((a, b) => a.pos - b.pos);
  }

  /** Remove all cursor state for a document (e.g. when the file is closed). */
  clear(docPath: string): void {
    this.cursors.delete(docPath);
  }
}
