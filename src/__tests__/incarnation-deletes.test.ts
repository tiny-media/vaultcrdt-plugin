import { afterEach, describe, expect, it, vi } from 'vitest';
import { encode, decode } from '@msgpack/msgpack';

vi.mock('obsidian', () => ({
  App: class {}, TFile: class { path = 'a.md'; }, MarkdownView: class {},
  Notice: class {}, requestUrl: vi.fn(), normalizePath: (p: string) => p,
}));
vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn(), redact: (s: string) => s }));
vi.mock('../wasm-bridge', () => ({ createDocument: () => {
  let text = 'same';
  return {
    text_matches: (s: string) => s === text, get_text: () => text,
    sync_from_disk: (s: string) => { text = s; }, version: () => 1,
    export_snapshot: () => new Uint8Array([1]), export_vv_json: () => '{}',
    export_delta_since_vv_json: () => new Uint8Array([2]), import_snapshot: () => {},
  };
} }));

import { SyncEngine } from '../sync-engine';
import { StateStorage, type DeleteJournalEntry } from '../state-storage';
import { OwnershipCache, OWNERSHIP_CACHE_FILE, nextRequestId } from '../ownership-cache';
import { warn } from '../logger';

const dir = '.obsidian/plugins/vaultcrdt/state/';
const journal = dir + 'delete-journal.json';
const flush = async () => { for (let i = 0; i < 150; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const engines: SyncEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) (engine as any).stopHeartbeat();
  vi.clearAllMocks();
});
function fixture(files = new Map<string, string>(), authenticated = true) {
  const adapter = {
    exists: vi.fn(async (p: string) => p === dir.slice(0, -1) || files.has(p)),
    read: vi.fn(async (p: string) => files.get(p)!),
    write: vi.fn(async (p: string, s: string) => { files.set(p, s); }),
    mkdir: vi.fn(async () => {}), remove: vi.fn(async (p: string) => { files.delete(p); }),
    readBinary: vi.fn(async () => new ArrayBuffer(0)), writeBinary: vi.fn(async () => {}),
    list: vi.fn(async () => ({ files: [...files.keys()], folders: [] })),
  };
  const app = { vault: { adapter, getMarkdownFiles: vi.fn(() => []), read: vi.fn(async () => 'same'),
    getAbstractFileByPath: vi.fn(() => null) }, workspace: {
    iterateAllLeaves: vi.fn(), getActiveViewOfType: vi.fn(() => null),
  } } as any;
  const engine = new SyncEngine(app, { peerId: 'p', vaultId: 'v' } as any);
  engines.push(engine);
  const frames: any[] = [];
  const ws = { readyState: 1, send: (bytes: Uint8Array): void => { frames.push(decode(bytes)); }, close: vi.fn() };
  (engine as any).ws = ws;
  engine.onInitialSync = () => {};
  const receive = (frame: object) => (engine as any).onMessage(encode(frame).slice().buffer);
  if (authenticated) receive({ type: 'auth_ok', capabilities: ['delete_incarnation'] });
  const push = (engine as any).push;
  const docs = (engine as any).docs;
  const clean = vi.spyOn(docs as { removeAndClean: (p: string) => Promise<void> }, 'removeAndClean');
  const deletes = () => frames.filter(f => f.type === 'doc_delete');
  const starts = () => frames.filter(f => f.type === 'sync_start');
  const entry = (): DeleteJournalEntry => push.pendingDeletes.get('a.md');
  const resolve = (incarnation = 7) => receive({ type: 'sync_delta', doc_uuid: 'a.md',
    delta: new Uint8Array([1]), server_vv: new TextEncoder().encode('{}'), incarnation });
  const disk = (): DeleteJournalEntry[] => JSON.parse(files.get(journal)!).entries;
  return { engine, push, docs, clean, ws, frames, receive, deletes, starts, entry, resolve, disk, files, adapter, app };
}

describe('ADR-0006 incarnation deletes', () => {
  it('§6.1 echoed grant persists across restart and authorizes delete without SyncStart', async () => {
    const f = fixture();
    f.push.pushDocCreate('a.md', await f.docs.getOrLoad('a.md'));
    const request = f.frames.find(m => m.type === 'doc_create');
    expect(request.request_id).toMatch(/^[0-9a-f-]{36}$/);
    f.receive({ type: 'ack', request_id: request.request_id, incarnation: 19 });
    await flush();
    expect(f.engine.ownership.ownedTokens.get('a.md')).toBe(19);
    const restarted = fixture(f.files);
    await restarted.engine.ownership.load();
    expect(restarted.engine.ownership.ownedTokens.get('a.md')).toBe(19);
    restarted.engine.onFileDeleted('a.md');
    await flush();
    expect(restarted.starts()).toEqual([]);
    expect(restarted.deletes()).toEqual([expect.objectContaining({ expected_incarnation: 19 })]);
    const reloaded = new OwnershipCache(new StateStorage(f.app));
    await reloaded.load();
    expect(reloaded.ownedTokens.size).toBe(0);
  });

  it.each([{ incarnation: 8 }, { incarnation: 8, request_id: 'foreign' }, {}])(
    '§6.2 capable server grants nothing from uncorrelated Ack %j', async ack => {
      const f = fixture();
      f.push.pushDocCreate('a.md', await f.docs.getOrLoad('a.md'));
      expect(f.engine.ownership.pendingGrants.size).toBe(1);
      f.receive({ type: 'ack', ...ack });
      await flush();
      expect(f.engine.ownership.ownedTokens.size).toBe(0);
      f.engine.onFileDeleted('a.md');
      await flush();
      expect(f.starts()).toHaveLength(1);
      f.resolve();
      await flush();
      expect(f.deletes()[0].expected_incarnation).toBe(7);
    });

  it('§6.3 DocList, SyncDelta and broadcast observations never grant ownership', async () => {
    const f = fixture();
    const list = f.engine.requestDocList();
    f.receive({ type: 'doc_list', docs: [{ doc_uuid: 'a.md', incarnation: 23 }], tombstones: [] });
    expect((await list).docs).toHaveLength(1);
    f.receive({ type: 'sync_delta', doc_uuid: 'a.md', delta: new Uint8Array(), server_vv: new Uint8Array(), incarnation: 23 });
    (f.engine as any).initialSyncRunning = true;
    f.receive({ type: 'delta_broadcast', doc_uuid: 'a.md', delta: new Uint8Array(), incarnation: 23 });
    await flush();
    expect(f.engine.ownership.ownedTokens.size).toBe(0);
    expect(f.files.has(dir + OWNERSHIP_CACHE_FILE)).toBe(false);
  });

  it('§6.4a recreation fences resolution before cleanup and send', async () => {
    const f = fixture();
    f.engine.onFileDeleted('a.md');
    await flush();
    expect(f.starts()).toHaveLength(1);
    f.push.admitRecreation('a.md');
    f.resolve();
    await flush();
    expect(f.clean).not.toHaveBeenCalled();
    expect(f.deletes()).toEqual([]);
  });

  it('§6.4b recreation during cleanup still fences send', async () => {
    const f = fixture();
    const gate = deferred<void>();
    f.clean.mockImplementation(() => gate.promise);
    f.engine.onFileDeleted('a.md');
    await flush();
    f.resolve();
    await flush();
    expect(f.clean).toHaveBeenCalledOnce();
    f.push.admitRecreation('a.md');
    gate.resolve();
    await flush();
    expect(f.deletes()).toEqual([]);
  });

  it('§6.4c initial-sync snapshot invalidates before deferred DocList and preserves recreate pass', async () => {
    const f = fixture();
    f.engine.onFileDeleted('a.md');
    await flush();
    expect(f.starts()).toHaveLength(1);
    f.app.vault.getMarkdownFiles.mockReturnValue([{ path: 'a.md' }]);
    const initial = f.engine.initialSync();
    expect(f.push.hasPendingDelete('a.md')).toBe(false);
    f.resolve();
    await flush();
    expect(f.clean).not.toHaveBeenCalled();
    expect(f.deletes()).toEqual([]);
    f.receive({ type: 'doc_list', docs: [], tombstones: ['a.md'] });
    await initial;
    expect(f.frames).toContainEqual(expect.objectContaining({ type: 'doc_create', replace_tombstone: true }));
  });

  it('§6.5 attempted=true alone blocks crash replay over recreation B', async () => {
    const f = fixture();
    const d: DeleteJournalEntry = { path: 'a.md', acked: false, intent_id: nextRequestId(),
      token: { kind: 'pinned', value: 7 }, attempted: true };
    await f.docs.saveDeleteJournal([d]);
    const restarted = fixture(f.files);
    await restarted.push.loadPendingDeletesFromJournal();
    expect(restarted.entry().acked).toBe(false);
    restarted.push.resendPendingDeletes();
    await flush();
    expect(restarted.starts()).toEqual([]);
    expect(restarted.deletes()).toEqual([]); // No request can affect server recreation B.
    expect(restarted.clean).not.toHaveBeenCalled();
  });

  it.each([1, 2])('§6.6 write %s failure fails closed; recovery sends only after durable attempt', async failure => {
    const f = fixture();
    let writes = 0;
    const save = f.adapter.write.getMockImplementation()!;
    f.adapter.write.mockImplementation(async (p, s) => {
      if (p === journal && ++writes === failure) throw new Error('disk unavailable');
      await save(p, s);
    });
    f.engine.onFileDeleted('a.md');
    await flush();
    if (failure === 2) { f.resolve(31); await flush(); }
    expect(f.deletes()).toEqual([]);
    expect(f.clean).not.toHaveBeenCalled();
    expect(f.entry().attempted).toBe(false);
    expect(warn).toHaveBeenCalled();
    expect(f.entry().token).toEqual(failure === 1 ? { kind: 'unresolved' } : { kind: 'pinned', value: 31 });
    f.ws.send = bytes => {
      const frame = decode(bytes) as any;
      if (frame.type === 'doc_delete') {
        expect(f.disk()[0]).toMatchObject({ intent_id: frame.intent_id, attempted: true,
          token: { kind: 'pinned', value: frame.expected_incarnation } });
      }
      f.frames.push(frame);
    };
    f.push.resendPendingDeletes();
    await flush();
    if (failure === 1) { f.resolve(31); await flush(); }
    expect(f.deletes()).toHaveLength(1);
    expect(f.deletes()[0].expected_incarnation).toBe(31);
    expect(f.starts()).toHaveLength(1);
  });

  it('§6.7 rejection retires only current exact intent; missing and superseded IDs do nothing', async () => {
    const f = fixture();
    f.ws.readyState = 3;
    f.engine.onFileDeleted('a.md');
    const d1 = f.entry().intent_id;
    await flush();
    f.engine.onFileDeleted('a.md');
    const d2 = f.entry().intent_id;
    expect(d1).not.toBe(d2);
    await flush();
    for (const intent_id of [undefined, d1]) {
      f.receive({ type: 'delete_rejected', doc_uuid: 'a.md', intent_id });
      await flush();
      expect(f.entry().intent_id).toBe(d2);
      expect(f.disk()[0].intent_id).toBe(d2);
    }
    f.receive({ type: 'delete_rejected', doc_uuid: 'a.md', intent_id: d2 });
    await flush();
    expect(f.entry()).toBeUndefined();
    expect(f.disk()).toEqual([]);
  });

  it('§6.8 pinned-unattempted journal reuses the exact value without resolution', async () => {
    const f = fixture();
    await f.docs.saveDeleteJournal([{ path: 'a.md', acked: false, intent_id: nextRequestId(),
      token: { kind: 'pinned', value: 41 }, attempted: false }]);
    await f.push.loadPendingDeletesFromJournal();
    f.push.resendPendingDeletes();
    await flush();
    expect(f.starts()).toEqual([]);
    expect(f.deletes()[0].expected_incarnation).toBe(41);
  });

  it('§6.9 real MessagePack decoder tolerates additive types and fields and handles rejection', async () => {
    const f = fixture();
    f.ws.readyState = 3;
    f.engine.onFileDeleted('a.md');
    await flush();
    const retire = vi.spyOn(f.push, 'retireRejectedDelete');
    expect(() => f.receive({ type: 'future_variant', extra: 1 })).not.toThrow();
    expect(() => f.receive({ type: 'ack', extra: { future: true } })).not.toThrow();
    f.receive({ type: 'delete_rejected', doc_uuid: 'a.md', intent_id: f.entry().intent_id, extra: 1 });
    await flush();
    expect(retire).toHaveBeenCalledOnce();
    expect(f.entry()).toBeUndefined();
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('undecodable'), expect.anything());
  });

  it.each(['different', 'same'])('§6.11 admission preserves replace routing for %s text', async text => {
    const f = fixture();
    await f.docs.getOrLoad('a.md');
    f.ws.readyState = 3;
    f.engine.onFileDeleted('a.md');
    await flush();
    f.engine.admitRecreation('a.md');
    expect(f.push.hasPendingDelete('a.md')).toBe(false);
    f.ws.readyState = 1;
    f.engine.onFileChangedImmediate('a.md', text);
    await flush();
    if (text === 'same') {
      expect(f.frames.filter(m => m.type === 'doc_create')).toEqual([]);
      expect(f.push.serverTombstones.has('a.md')).toBe(true);
      f.engine.onFileChangedImmediate('a.md', 'next edit');
      await flush();
    }
    expect(f.frames.filter(m => m.type === 'doc_create')).toEqual([
      expect.objectContaining({ doc_uuid: 'a.md', replace_tombstone: true }),
    ]);
    expect(f.push.serverTombstones.has('a.md')).toBe(false);
  });

  it('§6.12 incapable AuthOk takes precedence over owned token and warns once', async () => {
    const f = fixture();
    const id = f.push.writeRequestId('a.md');
    f.receive({ type: 'ack', request_id: id, incarnation: 55 });
    await flush();
    f.receive({ type: 'auth_ok' });
    f.receive({ type: 'auth_ok' });
    expect(f.engine.deleteIncarnationCapable).toBe(false);
    f.engine.onFileDeleted('a.md');
    await flush();
    expect(f.starts()).toEqual([]);
    expect(f.deletes()[0].expected_incarnation).toBeNull();
    expect(vi.mocked(warn).mock.calls.filter(c => String(c[0]).includes('legacy unconditional'))).toHaveLength(1);
    f.receive({ type: 'auth_ok', capabilities: ['delete_incarnation'] });
    expect(f.engine.deleteIncarnationCapable).toBe(true);
  });

  it.each([true, false])('§6.15 pre-auth delete stays unresolved until negotiated capability=%s', async capable => {
    const f = fixture(new Map(), false);
    expect(f.ws.readyState).toBe(1);
    expect(f.engine.deleteIncarnationCapable).toBe('unknown');
    f.engine.onFileDeleted('a.md');
    await flush();
    const intentId = f.entry().intent_id;
    // Repeated resend cycles MUST NOT pin, resolve, clean up, or attempt a send.
    f.push.resendPendingDeletes();
    await flush();
    expect(f.entry()).toMatchObject({ token: { kind: 'unresolved' }, attempted: false, acked: false });
    expect(f.disk()).toEqual([expect.objectContaining({
      intent_id: intentId, token: { kind: 'unresolved' }, attempted: false, acked: false,
    })]);
    expect(f.starts()).toEqual([]);
    expect(f.clean).not.toHaveBeenCalled();
    expect(f.deletes()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();

    f.receive(capable ? { type: 'auth_ok', capabilities: ['delete_incarnation'] } : { type: 'auth_ok' });
    f.push.resendPendingDeletes();
    await flush();
    if (capable) {
      expect(f.starts()).toHaveLength(1);
      expect(f.deletes()).toEqual([]);
      f.resolve(73);
      await flush();
    } else {
      expect(f.starts()).toEqual([]);
    }
    expect(f.disk()[0]).toMatchObject({ intent_id: intentId, attempted: true,
      token: { kind: 'pinned', value: capable ? 73 : null } });
    expect(f.deletes()).toEqual([expect.objectContaining({
      intent_id: intentId, expected_incarnation: capable ? 73 : null,
    })]);
    expect(vi.mocked(warn).mock.calls.filter(c => String(c[0]).includes('legacy unconditional')))
      .toHaveLength(capable ? 0 : 1);
  });

  it('§6.13 legacy journal migrates both ack states; only unacked resolves and sends', async () => {
    const f = fixture(new Map([[journal, JSON.stringify({ entries: [
      { path: 'acked.md', acked: true }, { path: 'a.md', acked: false },
    ] })]]));
    await f.push.loadPendingDeletesFromJournal();
    expect(f.push.pendingDeletePaths()).toHaveLength(2);
    expect(f.entry()).toMatchObject({ intent_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      token: { kind: 'unresolved' }, attempted: false });
    f.push.resendPendingDeletes();
    await flush();
    expect(f.starts().map(m => m.doc_uuid)).toEqual(['a.md']);
    f.receive({ type: 'doc_unknown', doc_uuid: 'a.md' });
    await flush();
    expect(f.deletes()).toEqual([expect.objectContaining({ doc_uuid: 'a.md', expected_incarnation: 0 })]);
  });

  it('§6.14 case-only rename persists skip_cleanup on the old-path intent', async () => {
    const f = fixture();
    f.ws.readyState = 3;
    vi.spyOn(f.docs, 'movePath').mockResolvedValue(undefined);
    vi.spyOn(f.push, 'pushFileDelta').mockImplementation(() => {});
    f.push.onFileRenamed('a.md', 'A.md', 'same');
    await flush();
    expect(f.disk()).toEqual([expect.objectContaining({
      path: 'a.md', acked: false, attempted: false, skip_cleanup: true,
    })]);
    expect(f.deletes()).toEqual([]);
    expect(f.clean).not.toHaveBeenCalled();
  });

  it('§6.14 crash before movePath preserves old-path .loro state on reload and resend', async () => {
    const f = fixture();
    const snapshot = new Uint8Array([1, 2, 3]);
    const statePath = dir + 'a.md.loro';
    f.files.set(statePath, JSON.stringify([...snapshot]));
    const intent: DeleteJournalEntry = {
      path: 'a.md', acked: false, intent_id: nextRequestId(),
      token: { kind: 'unresolved' }, attempted: false, skip_cleanup: true,
    };
    // Crash boundary: only the journal is durable; movePath has never run.
    await f.docs.saveDeleteJournal([intent]);
    const restarted = fixture(f.files);
    restarted.adapter.readBinary.mockImplementation(async () =>
      new Uint8Array(JSON.parse(restarted.files.get(statePath)!)).buffer);
    const storage = new StateStorage(restarted.app);
    expect(await storage.load('a.md')).toEqual(snapshot);
    expect(await storage.load('A.md')).toBeNull();
    await restarted.push.loadPendingDeletesFromJournal();
    expect(restarted.entry().skip_cleanup).toBe(true);
    restarted.push.resendPendingDeletes();
    await flush();
    expect(restarted.starts().map(m => m.doc_uuid)).toEqual(['a.md']);
    restarted.resolve(7);
    await flush();
    expect(restarted.deletes()).toEqual([expect.objectContaining({
      doc_uuid: 'a.md', intent_id: intent.intent_id, expected_incarnation: 7,
    })]);
    expect(restarted.clean).not.toHaveBeenCalled();
    expect(restarted.adapter.remove).not.toHaveBeenCalledWith(statePath);
    expect(await storage.load('a.md')).toEqual(snapshot);
    expect(await storage.load('A.md')).toBeNull();
  });

  it('pending grants have a hard cap and matching terminal echoes remove entries', async () => {
    const f = fixture();
    const first = f.push.writeRequestId('first.md');
    for (let i = 0; i < 256; i++) f.push.writeRequestId(`${i}.md`);
    expect(f.engine.ownership.pendingGrants.size).toBe(256);
    expect(f.engine.ownership.pendingGrants.has(first)).toBe(false);
    for (const type of ['ack', 'error', 'delete_rejected']) {
      const request_id = f.push.writeRequestId('a.md');
      f.receive({ type, request_id });
      expect(f.engine.ownership.pendingGrants.has(request_id)).toBe(false);
    }
  });

  it('ownership cache survives orphan cleanup and removes paths not live at reconcile', async () => {
    const f = fixture();
    f.receive({ type: 'ack', request_id: f.push.writeRequestId('a.md'), incarnation: 8 });
    await flush();
    await new StateStorage(f.app).cleanOrphans(new Set());
    expect(f.adapter.remove).not.toHaveBeenCalledWith(dir + OWNERSHIP_CACHE_FILE);
    f.push.reconcilePendingDeletes(new Set(), new Set());
    await flush();
    const reloaded = new OwnershipCache(new StateStorage(f.app));
    await reloaded.load();
    expect(reloaded.ownedTokens.size).toBe(0);
  });
});
