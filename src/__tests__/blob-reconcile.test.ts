import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import init, { blake3_hex } from '../../wasm/vaultcrdt_wasm';
import { BlobIndex } from '../blob-index';
import { BlobUploader, type BlobUploaderDeps } from '../blob-uploader';
import { remoteDeleteKeptNoticeMessage, remoteDeleteTrashedNoticeMessage } from '../user-facing-copy';

beforeAll(async () => { await init({ module_or_path: readFileSync('wasm/vaultcrdt_wasm_bg.wasm') }); });
const path = 'a.png';
const bytes = new Uint8Array([1, 2, 3]);
function setup() {
  const files = new Map<string, string>();
  const index = new BlobIndex({ existsRaw: async name => files.has(name),
    readRaw: async name => files.get(name) ?? null,
    writeRaw: async (name, value) => { files.set(name, value); },
    loadJson: async <T,>(name: string) => JSON.parse(files.get(name) ?? 'null') as T | null,
    saveJson: async (name, value) => { files.set(name, JSON.stringify(value)); } });
  const hash = blake3_hex(bytes);
  index.update(path, { hash, size: 3, lastRemoteHash: hash, seq: 10, generation: 2 });
  const stat = vi.fn(async (): Promise<{ size: number } | null> => ({ size: 3 }));
  const trash = vi.fn();
  const uploader = new BlobUploader({ index, stat, readBinary: async () => bytes.buffer,
    writeBinary: vi.fn(), notify: vi.fn(), serverUrl: () => '', peerId: () => '',
    getJwt: async () => '', blobsEnabled: async () => true, isMobile: false, now: () => 123,
    trashIfPresent: trash, removeFile: trash });
  const internal = uploader as unknown as {
    applyRemoteTombstone(row: object): Promise<void>;
    applyRemoteLive(row: object): Promise<void>;
    postPath(row: object): Promise<unknown>;
    http(...args: unknown[]): Promise<unknown>;
    reference(path: string, key: string, hash: string, size: number, bytes: Uint8Array): Promise<void>;
  };
  const row = { path_key: index.get(path)!.key, seq: 12, generation: 3, content_hash: hash, size: 3 };
  const deps = (uploader as unknown as { deps: BlobUploaderDeps }).deps;
  return { index, hash, stat, trash, uploader, internal, row, deps, files };
}
function held<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const republish = { kind: 'republish' as const, seq: 12, generation: 3 };

describe('pending decision reconciliation', () => {
  it('defers tombstones for hydration effects and rearms exactly once on settlement', async () => {
    const s = setup();
    const token = s.uploader.pathEffects.register(path, { kind: 'hydration', seq: 10, hash: s.hash });
    const http = vi.spyOn(s.internal, 'http').mockResolvedValue({ status: 200, json: {
      states: [{ ...s.row, state: 'deleted', display_path: path }], max_seq: 12,
    } });
    await s.uploader.catchUp();
    expect(s.index.cursor()).toBe(0); expect(s.index.get(path)?.pendingDecision).toBeUndefined();
    expect(http).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(http).toHaveBeenCalledTimes(1);
    s.stat.mockResolvedValue(null);
    s.uploader.pathEffects.settle(token);
    await s.uploader.catchUp();
    expect(http).toHaveBeenCalledTimes(2); expect(s.index.cursor()).toBe(12);
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(http).toHaveBeenCalledTimes(2);
  });
  function admitted() {
    const s = setup();
    s.index.update(path, { seq: 12, pendingDecision: {
      kind: 'delete', seq: 12, generation: 30, expectedHash: s.hash, expectedSize: 3,
    } });
    return s;
  }
  it('trashes an identity match, verifies absence, then removes and notifies', async () => {
    const s = admitted();
    s.trash.mockImplementation(async () => { s.stat.mockResolvedValue(null); });
    await s.uploader.reconcilePendingDeletes(false);
    expect(s.trash).toHaveBeenCalledExactlyOnceWith(path);
    expect(s.index.get(path)).toBeUndefined();
    expect(s.deps.notify).toHaveBeenCalledWith(remoteDeleteTrashedNoticeMessage(path));
  });
  it('missing file commits without a destructive effect', async () => {
    const s = admitted(); s.stat.mockResolvedValue(null);
    await s.uploader.reconcilePendingDeletes(false);
    expect(s.index.get(path)).toBeUndefined(); expect(s.trash).not.toHaveBeenCalled();
  });
  it('no-op trash keeps the decision', async () => {
    const s = admitted();
    await s.uploader.reconcilePendingDeletes(false);
    expect(s.index.get(path)?.pendingDecision?.kind).toBe('delete');
  });
  it.each(['size', 'hash', 'stability'])('%s mismatch durably transitions before any republish', async mismatch => {
    const s = admitted();
    if (mismatch === 'size') s.stat.mockResolvedValue({ size: 4 });
    if (mismatch === 'hash') s.deps.readBinary = async () => new Uint8Array([3, 2, 1]).buffer;
    if (mismatch === 'stability') s.stat.mockResolvedValueOnce({ size: 3 }).mockResolvedValue({ size: 4 });
    const http = vi.spyOn(s.internal, 'http');
    await s.uploader.reconcilePendingDeletes(false);
    s.index.dispose();
    const restored = new BlobIndex({
      existsRaw: async name => s.files.has(name), readRaw: async name => s.files.get(name) ?? null,
      writeRaw: async (name, value) => { s.files.set(name, value); },
      loadJson: async <T,>(name: string) => JSON.parse(s.files.get(name) ?? 'null') as T | null,
      saveJson: async (name, value) => { s.files.set(name, JSON.stringify(value)); },
    });
    await restored.load();
    expect(restored.get(path)?.pendingDecision).toEqual({ kind: 'republish', seq: 12, generation: 30 });
    expect(http).not.toHaveBeenCalled(); expect(s.trash).not.toHaveBeenCalled();
    restored.dispose();
  });
  it.each(['ack', 'lost', 'error'])('republish %s outcome and generations-ahead POST', async outcome => {
    const s = admitted();
    s.index.update(path, { pendingDecision: { ...republish, generation: 30 } });
    vi.spyOn(s.internal, 'http').mockResolvedValue({ status: 200, json: { exists: true } });
    const post = vi.spyOn(s.internal, 'postPath');
    if (outcome === 'error') post.mockRejectedValue(new Error('offline'));
    else post.mockResolvedValue({ status: outcome === 'lost' ? 409 : 200,
      json: { accepted: outcome === 'ack', seq: 13 } });
    await s.uploader.reconcilePendingDeletes(true);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ generation: 31 }));
    if (outcome === 'error') expect(s.index.get(path)?.pendingDecision?.kind).toBe('republish');
    else expect(s.index.get(path)?.pendingDecision).toBeUndefined();
    if (outcome === 'ack') expect(s.index.get(path)).toMatchObject({ seq: 13, hash: s.hash, generation: 31, hydrated: true });
    if (outcome === 'lost') expect(s.deps.notify).toHaveBeenCalledWith(remoteDeleteKeptNoticeMessage(path));
    expect(s.trash).not.toHaveBeenCalled();
  });
  it('a 409 cannot clear an entry updated during the attempt even with the same token', async () => {
    const s = admitted(); s.index.update(path, { pendingDecision: republish });
    vi.spyOn(s.internal, 'http').mockResolvedValue({ status: 200, json: { exists: true } });
    vi.spyOn(s.internal, 'postPath').mockImplementation(async () => {
      s.index.update(path, { hydrated: false });
      return { status: 409, json: {} };
    });
    await s.uploader.reconcilePendingDeletes(true);
    expect(s.index.get(path)?.pendingDecision).toEqual(republish);
    expect(s.deps.notify).not.toHaveBeenCalled();
  });
  it('network-ready mismatch waits for durable transition before the POST', async () => {
    const s = admitted(); const gate = held<void>();
    s.stat.mockResolvedValue({ size: 4 });
    const flush = s.index.flush.bind(s.index);
    const checkpoint = vi.spyOn(s.index, 'flush').mockImplementation(async () => { await gate.promise; await flush(); });
    const http = vi.spyOn(s.internal, 'http').mockResolvedValue({ status: 200, json: { exists: true } });
    vi.spyOn(s.internal, 'postPath').mockImplementation(async () => {
      expect(JSON.parse(s.files.get('blob-index.json')!).paths[path].pendingDecision.kind).toBe('republish');
      return { status: 409, json: {} };
    });
    const work = s.uploader.reconcilePendingDeletes(true);
    await vi.waitFor(() => expect(checkpoint).toHaveBeenCalledOnce());
    expect(http).not.toHaveBeenCalled(); gate.resolve(); await work;
    expect(s.index.get(path)?.pendingDecision).toBeUndefined(); expect(s.trash).not.toHaveBeenCalled();
  });
  it('failed transition checkpoint refuses the network attempt', async () => {
    const s = admitted(); s.stat.mockResolvedValue({ size: 4 });
    vi.spyOn(s.index, 'flush').mockRejectedValue(new Error('disk unavailable'));
    const http = vi.spyOn(s.internal, 'http');
    await s.uploader.reconcilePendingDeletes(true);
    expect(s.index.get(path)?.pendingDecision?.kind).toBe('republish');
    expect(http).not.toHaveBeenCalled(); expect(s.trash).not.toHaveBeenCalled();
  });
  it('missing republish file retains the obligation', async () => {
    const s = admitted(); s.index.update(path, { pendingDecision: republish }); s.stat.mockResolvedValue(null);
    await s.uploader.reconcilePendingDeletes(true);
    expect(s.index.get(path)?.pendingDecision).toEqual(republish);
  });
  function category() {
    const s = admitted(); s.index.remove(path);
    const disk = new Map<string, Uint8Array>(); const dirs = new Set<string>();
    const add = (p: string, value = bytes) => {
      disk.set(p, value);
      s.index.update(p, { hash: s.hash, seq: 12, generation: 2, pendingDecision: {
        kind: 'delete', seq: 12, generation: 30, expectedHash: s.hash, expectedSize: 3,
      } });
    };
    s.deps.obsidianSyncEnabled = () => ({ settings: true, styles: true });
    s.deps.stat = async p => disk.has(p) ? { size: disk.get(p)!.length } : dirs.has(p) ? { size: 0 } : null;
    s.deps.readBinary = async p => disk.get(p)!.slice().buffer;
    s.deps.mkdir = vi.fn(async p => { dirs.add(p); });
    s.deps.rename = vi.fn(async (a, b) => {
      if (disk.has(b)) throw new Error('would overwrite');
      disk.set(b, disk.get(a)!); disk.delete(a);
    });
    return { ...s, disk, add, list: () => [...disk.keys()] };
  }
  it('category moves preserve different themes and recreated same-path collisions independently', async () => {
    const s = category();
    const a = '.obsidian/themes/one/theme.css'; const b = '.obsidian/themes/two/theme.css';
    s.add(a); s.add(b);
    await s.uploader.reconcilePendingDeletes(false);
    s.add(a);
    await s.uploader.reconcilePendingDeletes(false);
    expect(s.list().sort()).toEqual([
      '.trash/vaultcrdt/123-seq12-.obsidian~themes~one~theme.css',
      '.trash/vaultcrdt/123-seq12-.obsidian~themes~one~theme.css-2',
      '.trash/vaultcrdt/123-seq12-.obsidian~themes~two~theme.css',
    ]);
    expect([...s.disk.values()]).toEqual([bytes, bytes, bytes]);
    expect(s.deps.mkdir).toHaveBeenCalledTimes(2); expect(s.trash).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
  it.each(['mkdir', 'rename'] as const)('%s failure keeps source and decision', async effect => {
    const s = category(); const p = '.obsidian/themes/one/theme.css'; s.add(p);
    s.deps[effect] = vi.fn(async () => { throw new Error('refused'); });
    await s.uploader.reconcilePendingDeletes(false);
    expect(s.list()).toEqual([p]); expect(s.index.get(p)?.pendingDecision?.kind).toBe('delete');
    expect(s.trash).not.toHaveBeenCalled(); vi.restoreAllMocks();
  });
  it('toggle-off immediately before rename detaches without deleting', async () => {
    const s = category(); const p = '.obsidian/themes/one/theme.css'; s.add(p);
    s.deps.mkdir = async () => { s.deps.obsidianSyncEnabled = () => ({ settings: false, styles: false }); };
    await s.uploader.reconcilePendingDeletes(false);
    expect(s.index.get(p)).toBeUndefined(); expect(s.disk.has(p)).toBe(true);
    expect(s.deps.rename).not.toHaveBeenCalled(); vi.restoreAllMocks();
  });
  it('an edit during the rename await lands in the recovery copy', async () => {
    const s = category(); const p = '.obsidian/themes/one/theme.css'; s.add(p);
    const move = s.deps.rename!; const gate = held<void>();
    s.deps.rename = vi.fn(async (a, b) => { await gate.promise; await move(a, b); });
    const work = s.uploader.reconcilePendingDeletes(false);
    await vi.waitFor(() => expect(s.deps.rename).toHaveBeenCalledOnce());
    const edited = new Uint8Array([4, 5, 6]); s.disk.set(p, edited);
    gate.resolve(); await work;
    expect([...s.disk.values()]).toEqual([edited]); vi.restoreAllMocks();
  });
  it('startup reconcile coalesces; catch-up queues afterwards and tail never deadlocks', async () => {
    const s = admitted(); const gate = held<{ size: number } | null>(); const order: string[] = [];
    s.stat.mockImplementationOnce(async () => { order.push('reconcile-start'); const result = await gate.promise; order.push('reconcile-end'); return result; });
    vi.spyOn(s.internal, 'http').mockImplementation(async () => { order.push('catch-up'); return { status: 200, json: { states: [], max_seq: 0 } }; });
    const one = s.uploader.reconcilePendingDeletes(false);
    expect(s.uploader.reconcilePendingDeletes(false)).toBe(one);
    const two = s.uploader.catchUp();
    expect(s.uploader.catchUp()).toBe(two);
    await vi.waitFor(() => expect(order).toEqual(['reconcile-start']));
    gate.resolve(null); await Promise.all([one, two]);
    expect(order).toEqual(['reconcile-start', 'reconcile-end', 'catch-up']);
  });
  it('reconcile requested during catch-up waits behind its internal tail', async () => {
    const s = admitted(); const gate = held<unknown>();
    const http = vi.spyOn(s.internal, 'http').mockReturnValue(gate.promise);
    const pass = s.uploader.catchUp();
    await vi.waitFor(() => expect(http).toHaveBeenCalledOnce());
    s.trash.mockImplementation(async () => { s.stat.mockResolvedValue(null); });
    const reconcile = s.uploader.reconcilePendingDeletes(false);
    gate.resolve({ status: 200, json: { states: [], max_seq: 0 } });
    await Promise.all([pass, reconcile]); expect(s.trash).toHaveBeenCalledOnce();
  });
  it.each(['stat', 'read', 'post'])('new authority during %s await survives', async step => {
    const s = admitted(); const replace = () => s.index.update(path, { seq: 14, pendingDecision: undefined, hash: 'new' });
    if (step === 'stat') s.stat.mockImplementationOnce(async () => { replace(); return null; });
    if (step === 'read') s.deps.readBinary = async () => { replace(); return new Uint8Array([9]).buffer; };
    if (step === 'post') {
      s.index.update(path, { pendingDecision: republish });
      vi.spyOn(s.internal, 'http').mockResolvedValue({ status: 200, json: { exists: true } });
      vi.spyOn(s.internal, 'postPath').mockImplementation(async () => { replace(); return { status: 409, json: {} }; });
    }
    await s.uploader.reconcilePendingDeletes(true);
    expect(s.index.get(path)).toMatchObject({ seq: 14, hash: 'new' }); expect(s.trash).not.toHaveBeenCalled();
  });
  it.each([false, true])('poison aborts at admission or after await: %s', async afterAwait => {
    const s = admitted(); const before = s.index.get(path);
    const poison = vi.spyOn(s.index, 'poisoned').mockReturnValue(!afterAwait);
    if (afterAwait) s.stat.mockImplementationOnce(async () => { poison.mockReturnValue(true); return null; });
    await s.uploader.reconcilePendingDeletes(true);
    expect(s.index.get(path)).toEqual(before); expect(s.trash).not.toHaveBeenCalled();
  });
});

describe('decision admissions (reconciliation effects are deferred)', () => {
  it('awaits durable delete admission and replays without effects', async () => {
    const s = setup();
    const gate = held<void>();
    const flush = vi.spyOn(s.index, 'flush').mockReturnValue(gate.promise);
    let done = false;
    const work = s.internal.applyRemoteTombstone(s.row).then(() => { done = true; });
    await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce());
    expect(done).toBe(false);
    expect(s.index.get(path)).toMatchObject({ seq: 12, pendingDecision: {
      kind: 'delete', expectedHash: s.hash, expectedSize: 3, seq: 12, generation: 3,
    } });
    expect(s.trash).not.toHaveBeenCalled();
    gate.resolve(); await work;
    s.stat.mockClear();
    await s.internal.applyRemoteTombstone(s.row);
    expect(s.stat).not.toHaveBeenCalled();
    expect(flush).toHaveBeenCalledOnce();
  });
  it('newer live clears a decision and marks absent content unhydrated', async () => {
    const s = setup();
    s.index.update(path, { seq: 12, pendingDecision: republish, hydrated: true });
    s.stat.mockResolvedValue(null);
    await s.internal.applyRemoteLive({ ...s.row, seq: 14 });
    expect(s.index.get(path)).toMatchObject({ seq: 14, hydrated: false });
    expect(s.index.get(path)?.pendingDecision).toBeUndefined();
  });
  it('ignores a stale reference ack', async () => {
    const s = setup();
    vi.spyOn(s.internal, 'http').mockResolvedValue({ status: 200, json: { accepted: true, seq: 9 } });
    const before = { ...s.index.get(path)! };
    await s.internal.reference(path, before.key, 'other', 9, bytes);
    expect(s.index.get(path)).toEqual(before);
  });
  it.each(['a.PNG', 'b.png'])('delayed rename ack cannot replace decision 12: %s', async newPath => {
    const s = setup(); const gate = held<unknown>();
    const post = vi.spyOn(s.internal, 'postPath').mockReturnValueOnce(gate.promise)
      .mockResolvedValue({ status: 200, json: { accepted: true, seq: 13 } });
    const work = s.uploader.onFileRenamed(path, newPath);
    await vi.waitFor(() => expect(post).toHaveBeenCalledOnce());
    s.index.update(path, { seq: 12, pendingDecision: republish });
    gate.resolve({ status: 200, json: { accepted: true, seq: 11 } }); await work;
    expect(s.index.get(path)).toMatchObject({ seq: 12, pendingDecision: republish });
  });
  it.each([false, true])('offline rename preserves authority only for same key: %s', async same => {
    const s = setup();
    s.index.update(path, { seq: 12, pendingDecision: republish });
    const deps = (s.uploader as unknown as { deps: { blobsEnabled(): Promise<boolean> } }).deps;
    deps.blobsEnabled = async () => false;
    const dest = same ? 'a.PNG' : 'b.png';
    await s.uploader.onFileRenamed(path, dest);
    expect(s.index.get(dest)?.seq).toBe(same ? 12 : 0);
    expect(s.index.get(dest)?.pendingDecision).toEqual(same ? republish : undefined);
  });
  it('delete decision echo removes without POST', async () => {
    const s = setup();
    await s.internal.applyRemoteTombstone(s.row);
    const post = vi.spyOn(s.internal, 'postPath');
    await s.uploader.onFileDeleted(path);
    expect(post).not.toHaveBeenCalled(); expect(s.index.get(path)).toBeUndefined();
  });
  it.each([false, true])('unchanged deletion removes captured authority, decision=%s', async decision => {
    const s = setup(); s.stat.mockResolvedValue(null);
    if (decision) s.index.update(path, { seq: 12, pendingDecision: republish });
    const post = vi.spyOn(s.internal, 'postPath').mockResolvedValue({ status: 409, json: { accepted: false } });
    await s.uploader.onFileDeleted(path);
    expect(post).toHaveBeenCalledOnce();
    expect(s.index.get(path)).toBeUndefined();
  });
  it.each([false, true])('rejected deletion preserves newer authority, decision=%s', async decision => {
    const s = setup(); s.stat.mockResolvedValue(null);
    if (decision) s.index.update(path, { seq: 12, pendingDecision: republish });
    const gate = held<unknown>();
    const post = vi.spyOn(s.internal, 'postPath').mockReturnValue(gate.promise);
    const work = s.uploader.onFileDeleted(path);
    await vi.waitFor(() => expect(post).toHaveBeenCalledOnce());
    await s.internal.applyRemoteLive({ ...s.row, content_hash: 'new', seq: 14 });
    gate.resolve({ status: 409, json: { accepted: false } }); await work;
    expect(s.index.get(path)).toMatchObject({ seq: 14, hydrated: false });
  });
});

// F4 (opus verify): modified-admission durable-before-network — the
// applier writes a durable republish decision and performs NO network;
// the network attempt happens only later (reconcile), and the decision
// survives an index reload in between.
it('modified tombstone admission is durable before any network', async () => {
  const files = new Map<string, string>();
  const storage = { existsRaw: async (name: string) => files.has(name),
    readRaw: async (name: string) => files.get(name) ?? null,
    writeRaw: async (name: string, value: string) => { files.set(name, value); },
    loadJson: async <T,>(name: string) => JSON.parse(files.get(name) ?? 'null') as T | null,
    saveJson: async (name: string, value: unknown) => { files.set(name, JSON.stringify(value)); } };
  const index = new BlobIndex(storage);
  await index.load();
  index.update('a.png', { hash: 'server-hash', size: 3, lastRemoteHash: 'server-hash', seq: 4, generation: 1 });
  const net: string[] = [];
  const uploader = new BlobUploader({ index,
    stat: async () => ({ size: 3 }), readBinary: async () => new Uint8Array([9, 9, 9]).buffer,
    writeBinary: vi.fn(), notify: vi.fn(), serverUrl: () => '', peerId: () => '',
    getJwt: async () => '', blobsEnabled: async () => true, isMobile: false, now: () => 1 });
  (uploader as unknown as { http: (m: string, p: string) => Promise<unknown> }).http =
    async (m: string, p: string) => { net.push(`${m} ${p}`); return { status: 200, json: {}, headers: {}, arrayBuffer: new ArrayBuffer(0) }; };
  await (uploader as unknown as { applyRemoteTombstone: (row: object) => Promise<void> })
    .applyRemoteTombstone({ path_key: index.get('a.png')!.key, state: 'deleted', seq: 6, generation: 2 });
  expect(net).toEqual([]);
  expect(index.get('a.png')?.pendingDecision).toEqual({ kind: 'republish', seq: 6, generation: 2 });
  // BlobUploader has no dispose; the index flush is what matters here.
  index.dispose();
  const reloaded = new BlobIndex(storage);
  await reloaded.load();
  expect(reloaded.get('a.png')?.pendingDecision).toEqual({ kind: 'republish', seq: 6, generation: 2 });
});
