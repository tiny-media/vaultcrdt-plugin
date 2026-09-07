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
      saveDeleteJournal: vi.fn(async (entries: { path: string; acked: boolean }[]) => {
        call++;
        if (call === 1) await firstGate;
        writes.push(entries.map((e) => e.path));
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

describe('PushHandler excalidraw concurrent hold', () => {
  function makePush(opts: {
    lastServerVV?: Map<string, string>;
    path?: string;
    localVV?: string;
    send?: ReturnType<typeof vi.fn>;
  } = {}) {
    const stubDoc = {
      text_matches: () => false,
      sync_from_disk: vi.fn(),
      export_vv_json: () => opts.localVV ?? JSON.stringify({ me: 1 }),
      export_delta_since_vv_json: () => new Uint8Array(8),
      version: () => 1,
    };
    const docs = {
      saveDeleteJournal: vi.fn().mockResolvedValue(undefined),
      loadDeleteJournal: vi.fn().mockResolvedValue([]),
      movePath: vi.fn(),
      getOrLoad: vi.fn().mockResolvedValue(stubDoc),
      persist: vi.fn().mockResolvedValue(undefined),
      removeAndClean: vi.fn().mockResolvedValue(undefined),
    };
    const send = opts.send ?? vi.fn();
    const push = new PushHandler(
      docs as any,
      { readCurrentContent: vi.fn(() => null) } as any,
      send as any,
      { peerId: 'p', debounceMs: 700 } as any,
      new Map(),
      opts.lastServerVV ?? new Map(),
      vi.fn(),
      () => true,
      '[test]',
      vi.fn(),
    );
    return { push, stubDoc, send, docs };
  }

  it('does not sync_from_disk an excalidraw edit onto unseen server ops', async () => {
    const path = 'sketch.excalidraw.md';
    const { push, stubDoc, send } = makePush({
      lastServerVV: new Map([[path, JSON.stringify({ other: 4 })]]),
      localVV: JSON.stringify({ me: 1 }),
    });
    const handler = vi.fn().mockResolvedValue(true);
    push.onExcalidrawConcurrent = handler;
    push.onFileChangedImmediate(path, 'excalidrawjson:LOCAL');
    await vi.waitFor(() => expect(handler).toHaveBeenCalled());
    expect(stubDoc.sync_from_disk).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledWith(path, 'excalidrawjson:LOCAL');
  });

  it('still sync_from_disk when local VV already covers the server', async () => {
    const path = 'sketch.excalidraw.md';
    const vv = JSON.stringify({ me: 2, other: 4 });
    const { push, stubDoc, send } = makePush({
      lastServerVV: new Map([[path, vv]]),
      localVV: vv,
    });
    push.onFileChangedImmediate(path, 'excalidrawjson:NEXT');
    await vi.waitFor(() => expect(stubDoc.sync_from_disk).toHaveBeenCalled());
    expect(stubDoc.sync_from_disk).toHaveBeenCalledWith('excalidrawjson:NEXT');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'sync_push', doc_uuid: path, peer_id: 'p',
    }));
  });

  it('still merges concurrent non-excalidraw markdown', async () => {
    const path = 'note.md';
    const { push, stubDoc } = makePush({
      lastServerVV: new Map([[path, JSON.stringify({ other: 4 })]]),
      localVV: JSON.stringify({ me: 1 }),
    });
    const handler = vi.fn().mockResolvedValue(true);
    push.onExcalidrawConcurrent = handler;
    push.onFileChangedImmediate(path, 'local');
    await vi.waitFor(() => expect(stubDoc.sync_from_disk).toHaveBeenCalled());
    expect(handler).not.toHaveBeenCalled();
    expect(stubDoc.sync_from_disk).toHaveBeenCalledWith('local');
  });
});

describe('PushHandler delete journal ack and resend', () => {
  function makePush(sendMock = vi.fn()) {
    const docs = {
      saveDeleteJournal: vi.fn().mockResolvedValue(undefined),
      loadDeleteJournal: vi.fn().mockResolvedValue([]),
      movePath: vi.fn(),
      getOrLoad: vi.fn(),
      persist: vi.fn(),
      removeAndClean: vi.fn().mockResolvedValue(undefined),
    };
    const push = new PushHandler(
      docs as any,
      { readCurrentContent: () => null } as any,
      sendMock,
      { peerId: 'p', debounceMs: 0 } as any,
      new Map(),
      new Map(),
      vi.fn(),
      () => true,
      '[test]',
      vi.fn(),
    );
    return { push, sendMock, docs };
  }

  it('resendPendingDeletes sends only unacked entries', () => {
    const { push, sendMock } = makePush();
    (push as any).pendingDeletes.set('acked.md', { acked: true });
    (push as any).pendingDeletes.set('unacked.md', { acked: false });
    push.resendPendingDeletes();
    const deletes = sendMock.mock.calls.filter((c) => c[0]?.type === 'doc_delete');
    expect(deletes.map((c) => c[0].doc_uuid)).toEqual(['unacked.md']);
  });

  it('ackPendingDelete marks the journal entry acked', async () => {
    const { push, docs } = makePush();
    push.onFileDeleted('gone.md');
    expect((push as any).pendingDeletes.get('gone.md')?.acked).toBe(true);
    (push as any).pendingDeletes.set('gone.md', { acked: false });
    push.ackPendingDelete('gone.md');
    expect((push as any).pendingDeletes.get('gone.md')?.acked).toBe(true);
    await vi.waitFor(() => expect(docs.saveDeleteJournal).toHaveBeenCalled());
    const last = docs.saveDeleteJournal.mock.calls.at(-1)![0];
    expect(last).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'gone.md', acked: true })]));
  });

  it('reconcile drops acked live paths (resurrected) and keeps unacked live paths', () => {
    const { push } = makePush();
    (push as any).pendingDeletes.set('acked.md', { acked: true });
    (push as any).pendingDeletes.set('unacked.md', { acked: false });
    push.reconcilePendingDeletes(new Set(), new Set(['acked.md', 'unacked.md']));
    expect(push.pendingDeletePaths()).toEqual(['unacked.md']);
  });
});
