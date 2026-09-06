import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../logger', () => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import { PromiseManager } from '../promise-manager';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PromiseManager', () => {
  let pm: PromiseManager;

  beforeEach(() => {
    pm = new PromiseManager();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('waitFor', () => {
    it('resolves when resolve() is called', async () => {
      const promise = pm.waitFor<string>('req-1');
      pm.resolve('req-1', 'hello');
      await expect(promise).resolves.toBe('hello');
    });

    it('rejects on timeout', async () => {
      const promise = pm.waitFor<string>('req-timeout');
      vi.advanceTimersByTime(60_000);
      await expect(promise).rejects.toThrow('WS request timeout: req-timeout');
    });

    it('supersedes an existing pending entry immediately', async () => {
      const first = pm.waitFor<string>('same-key');
      const second = pm.waitFor<string>('same-key');
      await expect(first).rejects.toThrow('WS request superseded: same-key');
      pm.resolve('same-key', 'new');
      await expect(second).resolves.toBe('new');
    });
  });

  describe('reject', () => {
    it('rejects a single pending key', async () => {
      const p = pm.waitFor<string>('doc-x');
      pm.reject('doc-x', new Error('server error'));
      await expect(p).rejects.toThrow('server error');
    });

    it('is a no-op for unknown keys', () => {
      expect(() => pm.reject('missing', new Error('x'))).not.toThrow();
    });
  });

  describe('resolve', () => {
    it('resolves the correct key among multiple pending', async () => {
      const p1 = pm.waitFor<number>('key-a');
      const p2 = pm.waitFor<number>('key-b');
      pm.resolve('key-b', 42);
      await expect(p2).resolves.toBe(42);

      // key-a is still pending — advance timers to let it timeout and clean up
      vi.advanceTimersByTime(60_000);
      await expect(p1).rejects.toThrow();
    });

    it('ignoring unknown keys does not throw', () => {
      expect(() => pm.resolve('nonexistent', 'data')).not.toThrow();
    });
  });

  describe('rejectAll', () => {
    it('rejects all pending promises', async () => {
      const p1 = pm.waitFor<string>('a');
      const p2 = pm.waitFor<string>('b');
      pm.rejectAll('connection closed', '[WS]');
      await expect(p1).rejects.toThrow('connection closed');
      await expect(p2).rejects.toThrow('connection closed');
    });

    it('is a no-op when no pending promises', () => {
      expect(() => pm.rejectAll('no-op', '[WS]')).not.toThrow();
    });
  });
});
