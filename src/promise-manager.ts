const WS_REQUEST_TIMEOUT_MS = 60_000;

type PendingEntry = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class PromiseManager {
  private pending = new Map<string, PendingEntry>();

  /** Create a promise that resolves when resolve() is called, or rejects on timeout / WS close. */
  waitFor<T>(key: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`WS request timeout: ${key}`));
      }, WS_REQUEST_TIMEOUT_MS);

      this.pending.set(key, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
    });
  }

  resolve(key: string, value: unknown): void {
    const entry = this.pending.get(key);
    if (entry) {
      this.pending.delete(key);
      clearTimeout(entry.timer);
      entry.resolve(value);
    }
  }

  /** Reject all pending promises (called on WS close). */
  rejectAll(reason: string, tag: string): void {
    const count = this.pending.size;
    if (count === 0) return;
    console.warn(`${tag} rejecting ${count} pending promises: ${reason}`);
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
