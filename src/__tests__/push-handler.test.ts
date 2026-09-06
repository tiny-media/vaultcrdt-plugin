import { describe, it, expect, vi } from 'vitest';

vi.mock('../logger', () => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import { PushHandler } from '../push-handler';

describe('PushHandler persistJournal serialization', () => {
  it('serializes overlapping journal writes so the last snapshot wins', async () => {
    const writes: string[][] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => { releaseFirst = r; });
    let call = 0;

    const docs = {
      saveDeleteJournal: vi.fn(async (paths: string[]) => {
        call++;
        if (call === 1) await firstGate;
        writes.push([...paths]);
      }),
      loadDeleteJournal: vi.fn().mockResolvedValue([]),
      movePath: vi.fn(),
      getOrLoad: vi.fn(),
      persist: vi.fn(),
      removeAndClean: vi.fn().mockResolvedValue(undefined),
    };

    const push = new PushHandler(
      docs as any,
      { readCurrentContent: () => null } as any,
      vi.fn(),
      { peerId: 'p', debounceMs: 0 } as any,
      new Map(),
      new Map(),
      vi.fn(),
      () => true,
      '[test]',
      vi.fn(),
    );

    push.onFileDeleted('a.md');
    push.onFileDeleted('b.md');
    // First write still blocked; second is queued behind it.
    expect(writes).toEqual([]);
    releaseFirst();
    await vi.waitFor(() => expect(writes.length).toBe(2));
    // Last completed write must include both deletes (latest pendingDeletes snapshot).
    expect(writes[1]).toEqual(expect.arrayContaining(['a.md', 'b.md']));
  });
});
