import { warn } from './logger';

export type SyncDeltaResponse = { delta: Uint8Array; serverVV: string } | null;
type ResponseKind = 'sync_delta' | 'doc_unknown';
// Matches WS_REQUEST_TIMEOUT_MS in promise-manager.ts; bounds caller wait, not drain.
const REQUEST_TIMEOUT_MS = 60_000;
const DRAIN_GRACE_MS = 30_000;
type Waiter = {
  resolve: (value: SyncDeltaResponse) => void;
  reject: (error: Error) => void;
  timer: number;
};
type Entry = { clientVV: string | null; epoch: number; waiter?: Waiter; drainTimer?: number };

/** Per-path FIFO. A timed-out sent owner retains the wire slot until drain.
 * Outer waits (including the 5s tombstone probe) do not cancel broker entries.
 * Waiterless owners get 30s to drain before retiring their socket.
 */
export class SyncRequestBroker {
  private queues = new Map<string, Entry[]>();

  constructor(
    private sender: (docUuid: string, clientVV: string | null) => void,
    private unsolicited: (kind: ResponseKind, docUuid: string) => void,
    private epoch: () => number,
    private retire: (docUuid: string) => void,
  ) {}

  request(docUuid: string, clientVV: string | null): Promise<SyncDeltaResponse> {
    return new Promise((resolve, reject) => {
      const queue = this.queues.get(docUuid) ?? [];
      const entry: Entry = { clientVV, epoch: this.epoch() };
      const timer = window.setTimeout(() => {
        entry.waiter = undefined;
        reject(new Error(`WS request timeout: sync_delta:${docUuid}`));
        const index = queue.indexOf(entry);
        if (index > 0) queue.splice(index, 1);
        else if (index === 0) {
          entry.drainTimer = window.setTimeout(() => {
            if (queue[0] !== entry) return;
            if (entry.epoch !== this.epoch()) {
              queue.shift();
              this.rejectEntry(entry, new Error('Stale socket epoch'));
              this.sendHead(docUuid, queue);
            } else {
              // One-shot; onclose, not retire, owns queue cleanup.
              this.retire(docUuid);
            }
          }, DRAIN_GRACE_MS);
        }
      }, REQUEST_TIMEOUT_MS);
      entry.waiter = { resolve, reject, timer };
      queue.push(entry);
      this.queues.set(docUuid, queue);
      if (queue.length === 1) this.sendHead(docUuid, queue);
    });
  }

  deliver(docUuid: string, kind: ResponseKind, value: SyncDeltaResponse): boolean {
    const queue = this.queues.get(docUuid);
    if (!queue) return false;
    const entry = queue.shift()!;
    this.clearDrain(entry);
    if (entry.waiter) {
      window.clearTimeout(entry.waiter.timer);
      entry.waiter.resolve(value);
    } else {
      this.unsolicited(kind, docUuid);
    }
    this.sendHead(docUuid, queue);
    return true;
  }

  fail(docUuid: string, err: Error): boolean {
    const queue = this.queues.get(docUuid);
    if (!queue) return false;
    this.rejectEntry(queue.shift()!, err);
    this.sendHead(docUuid, queue);
    return true;
  }

  rejectAll(reason: string, tag: string): void {
    let count = 0;
    for (const queue of this.queues.values()) {
      for (const entry of queue) {
        if (entry.waiter) count++;
        this.rejectEntry(entry, new Error(reason));
      }
    }
    this.queues.clear();
    if (count) warn(`${tag} rejecting ${count} pending promises: ${reason}`);
  }

  private clearDrain(entry: Entry): void {
    if (entry.drainTimer !== undefined) window.clearTimeout(entry.drainTimer);
    entry.drainTimer = undefined;
  }

  private rejectEntry(entry: Entry, err: Error): void {
    this.clearDrain(entry);
    if (!entry.waiter) return;
    window.clearTimeout(entry.waiter.timer);
    entry.waiter.reject(err);
    entry.waiter = undefined;
  }

  private sendHead(docUuid: string, queue: Entry[]): void {
    // Iterative containment also avoids stack growth when many sends fail.
    while (queue.length) {
      try {
        this.sender(docUuid, queue[0].clientVV);
        return;
      } catch (err) {
        this.rejectEntry(queue.shift()!, err instanceof Error ? err : new Error(String(err)));
      }
    }
    this.queues.delete(docUuid);
  }
}
