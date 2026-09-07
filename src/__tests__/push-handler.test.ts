import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../logger', () => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import { PushHandler } from '../push-handler';

describe('PushHandler push debounce maxWait', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makePush(sendMock: any = vi.fn()) {
    const stubDoc = {
      text_matches: () => false,
      sync_from_disk: vi.fn(),
      export_vv_json: () => '{}',
      export_delta_since_vv_json: () => new Uint8Array(0),
    };
    const docs = {
      saveDeleteJournal: vi.fn().mockResolvedValue(undefined),
      loadDeleteJournal: vi.fn().mockResolvedValue([]),
      movePath: vi.fn(),
      getOrLoad: vi.fn().mockResolvedValue(stubDoc),
      persist: vi.fn().mockResolvedValue(undefined),
      removeAndClean: vi.fn().mockResolvedValue(undefined),
    };
    const push = new PushHandler(
      docs as any,
      { readCurrentContent: vi.fn(() => 'x') } as any,
      sendMock,
      { peerId: 'p', debounceMs: 700 } as any,
      new Map(),
      new Map(),
      vi.fn(),
      () => true,
      '[test]',
      vi.fn(),
    );
    const fire = vi.fn();
    (push as any).pushFileDelta = fire;
    return { push, fire };
  }

  it('single edit waits the full debounce', () => {
    const { push, fire } = makePush();
    push.onFileChanged('a.md');
    vi.advanceTimersByTime(699);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('continuous typing still pushes at maxWait', () => {
    const { push, fire } = makePush();
    for (let i = 0; i < 9; i++) {
      push.onFileChanged('a.md');
      vi.advanceTimersByTime(200);
    }
    // t = 1800 ms, never a pause >= 700 ms
    expect(fire).not.toHaveBeenCalled();
    push.onFileChanged('a.md');
    vi.advanceTimersByTime(200);
    // t = 2000 ms => maxWait window expired
    expect(fire).toHaveBeenCalledTimes(1);

    // Further typing stays bounded: at most one fire per 2000 ms window.
    for (let i = 0; i < 10; i++) {
      push.onFileChanged('a.md');
      vi.advanceTimersByTime(200);
    }
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it('flush resets the burst window', async () => {
    const { push, fire } = makePush(vi.fn());
    push.onFileChanged('a.md');
    vi.advanceTimersByTime(200);
    await push.flushPendingEdits('a.md');

    push.onFileChanged('a.md');
    vi.advanceTimersByTime(699);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('cancelPendingEdits resets the burst window too', () => {
    const { push, fire } = makePush();
    // Keep the burst window open (typing) up to t = 1500, then cancel.
    for (let i = 0; i < 5; i++) {
      push.onFileChanged('a.md');
      vi.advanceTimersByTime(300);
    }
    expect(fire).not.toHaveBeenCalled();
    push.cancelPendingEdits('a.md');

    push.onFileChanged('a.md');
    vi.advanceTimersByTime(699);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('flush without a timer folds and pushes differing editor content', async () => {
    const send = vi.fn();
    const stubDoc = {
      text_matches: vi.fn(() => false),
      sync_from_disk: vi.fn(),
      export_vv_json: () => '{}',
      export_delta_since_vv_json: () => new Uint8Array(8),
    };
    const docs = {
      saveDeleteJournal: vi.fn().mockResolvedValue(undefined),
      loadDeleteJournal: vi.fn().mockResolvedValue([]),
      movePath: vi.fn(),
      getOrLoad: vi.fn().mockResolvedValue(stubDoc),
      persist: vi.fn().mockResolvedValue(undefined),
      removeAndClean: vi.fn().mockResolvedValue(undefined),
    };
    const push = new PushHandler(
      docs as any,
      { readCurrentContent: vi.fn(() => 'abXY') } as any,
      send,
      { peerId: 'p', debounceMs: 700 } as any,
      new Map(),
      new Map(),
      vi.fn(),
      () => true,
      '[test]',
      vi.fn(),
    );
    await push.flushPendingEdits('a.md');
    expect(docs.getOrLoad).toHaveBeenCalledWith('a.md');
    expect(stubDoc.sync_from_disk).toHaveBeenCalledWith('abXY');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'sync_push', doc_uuid: 'a.md', peer_id: 'p',
    }));
  });

  it('flush without a timer returns immediately when the editor is closed', async () => {
    const stubDoc = {
      text_matches: vi.fn(),
      sync_from_disk: vi.fn(),
      export_vv_json: vi.fn(),
      export_delta_since_vv_json: vi.fn(),
    };
    const docs = {
      saveDeleteJournal: vi.fn().mockResolvedValue(undefined),
      loadDeleteJournal: vi.fn().mockResolvedValue([]),
      movePath: vi.fn(),
      getOrLoad: vi.fn().mockResolvedValue(stubDoc),
      persist: vi.fn().mockResolvedValue(undefined),
      removeAndClean: vi.fn().mockResolvedValue(undefined),
    };
    const push = new PushHandler(
      docs as any,
      { readCurrentContent: vi.fn(() => null) } as any,
      vi.fn(),
      { peerId: 'p', debounceMs: 700 } as any,
      new Map(),
      new Map(),
      vi.fn(),
      () => true,
      '[test]',
      vi.fn(),
    );
    await push.flushPendingEdits('a.md');
    expect(docs.getOrLoad).not.toHaveBeenCalled();
    expect(stubDoc.sync_from_disk).not.toHaveBeenCalled();
  });

  it('flush with a timer and a null read leaves the timer armed', async () => {
    const read = vi.fn<() => string | null>();
    const stubDoc = {
      text_matches: () => false,
      sync_from_disk: vi.fn(),
      export_vv_json: () => '{}',
      export_delta_since_vv_json: () => new Uint8Array(0),
    };
    const docs = {
      saveDeleteJournal: vi.fn().mockResolvedValue(undefined),
      loadDeleteJournal: vi.fn().mockResolvedValue([]),
      movePath: vi.fn(),
      getOrLoad: vi.fn().mockResolvedValue(stubDoc),
      persist: vi.fn().mockResolvedValue(undefined),
      removeAndClean: vi.fn().mockResolvedValue(undefined),
    };
    const push = new PushHandler(
      docs as any,
      { readCurrentContent: read } as any,
      vi.fn(),
      { peerId: 'p', debounceMs: 700 } as any,
      new Map(),
      new Map(),
      vi.fn(),
      () => true,
      '[test]',
      vi.fn(),
    );
    const fire = vi.fn();
    (push as any).pushFileDelta = fire;
    read.mockReturnValue(null);
    push.onFileChanged('a.md');
    await push.flushPendingEdits('a.md');
    expect(fire).not.toHaveBeenCalled();
    read.mockReturnValue('x');
    vi.advanceTimersByTime(700);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('paths are independent', () => {
    const { push, fire } = makePush();
    push.onFileChanged('a.md');
    push.onFileChanged('b.md');
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(200);
      push.onFileChanged('a.md');
    }
    // t = 600: nothing yet
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    // t = 700: b.md fired at its debounce, a.md's window is still open
    expect(fire).toHaveBeenCalledTimes(1);
    expect(fire).toHaveBeenCalledWith('b.md', 'x');
  });
});

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
