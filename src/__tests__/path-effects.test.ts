import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import init, { blake3_hex } from '../../wasm/vaultcrdt_wasm';
import { BlobIndex } from '../blob-index';
import { BlobUploader, type BlobUploaderDeps } from '../blob-uploader';
import { BlobDownloader } from '../blob-downloader';
import { PathEffects } from '../path-effects';

beforeAll(async () => { await init({ module_or_path: readFileSync('wasm/vaultcrdt_wasm_bg.wasm') }); });
function held() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
async function drain() { for (let i = 0; i < 100; i++) await Promise.resolve(); }
const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="1"/></svg>');
const fresh = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><circle r="2"/></svg>');
const path = 'a.svg';
function rig() {
  const storage = new Map<string, string>();
  const index = new BlobIndex({ existsRaw: async p => storage.has(p), readRaw: async p => storage.get(p) ?? null,
    writeRaw: async (p, text) => { storage.set(p, text); },
    loadJson: async <T,>(p: string) => JSON.parse(storage.get(p) ?? 'null') as T | null,
    saveJson: async (p, value) => { storage.set(p, JSON.stringify(value)); } });
  const disk = new Map<string, Uint8Array>([[path, svg]]);
  const gate = held(); const started = held();
  let hold = true;
  const writes = vi.fn(async (p: string, data: ArrayBuffer) => {
    if (hold) { hold = false; started.resolve(); await gate.promise; }
    disk.set(p, new Uint8Array(data));
  });
  let uploader!: BlobUploader;
  const trash = vi.fn(async (p: string) => {
    disk.delete(p);
    await uploader.onFileDeleted(p); // real synchronous vault echo admission
  });
  const deps: BlobUploaderDeps = { index, stat: async p => disk.has(p) ? { size: disk.get(p)!.length } : null,
    readBinary: async p => disk.get(p)!.slice().buffer, writeBinary: writes,
    trashIfPresent: trash, notify: vi.fn(), serverUrl: () => '', peerId: () => '',
    getJwt: async () => '', blobsEnabled: async () => true, isMobile: false, sleep: async () => {} };
  uploader = new BlobUploader(deps);
  const internal = uploader as unknown as {
    canonicalSvgBytes(p: string, b: Uint8Array, valid?: () => boolean, authority?: { kind: 'decision'; seq: number }): Promise<Uint8Array | null>;
    postPath(row: object): Promise<unknown>;
    http(...args: unknown[]): Promise<unknown>;
  };
  const post = vi.spyOn(internal, 'postPath').mockResolvedValue({ status: 200, json: { accepted: true, seq: 15 } });
  const downloader = new BlobDownloader({ index, pathEffects: uploader.pathEffects,
    serverUrl: () => '', getJwt: async () => '', blobsEnabled: async () => true,
    exists: async () => false, mkdir: async () => {}, writeBinary: writes, readBinary: deps.readBinary,
    enqueueUpload: p => uploader.onFileChanged(p), categoryEnabled: () => ({ settings: false, styles: false }),
    app: {} as never, isMobile: false, getFileCache: () => null });
  const download = vi.spyOn(downloader as unknown as { download(): Promise<Uint8Array> }, 'download').mockResolvedValue(fresh);
  const live = (seq: number, bytes = fresh) => index.update(path, { seq, hash: blake3_hex(bytes), size: bytes.length,
    hydrated: false, pendingDecision: undefined, lastRemoteHash: blake3_hex(bytes) });
  return { index, disk, gate, started, writes, trash, uploader, internal, post, downloader, download, live };
}

describe('shared path effects', () => {
  it('queues per path, isolates other paths, and releases rejected locks', async () => {
    const s = rig(); const gate = held(); const order: number[] = [];
    const a = s.uploader.pathEffects.withPathLock(path, async () => { order.push(1); await gate.promise; throw Error('failed'); });
    const rejection = expect(a).rejects.toThrow('failed');
    const b = s.uploader.pathEffects.withPathLock(path, async () => { order.push(2); });
    await s.uploader.pathEffects.withPathLock('other', async () => { order.push(3); });
    expect(order).toEqual([1, 3]); gate.resolve(); await rejection; await b;
    expect(order).toEqual([1, 3, 2]);
  });
  it('cancellation filters tokens, never newer registrations, and retires on settle', () => {
    const s = rig(); const effects = s.uploader.pathEffects;
    const old = effects.register(path, { kind: 'decision', seq: 12 });
    const upload = effects.register(path, { kind: 'upload' });
    effects.cancelByPath(path, a => a.kind === 'decision' && a.seq === 12);
    const newer = effects.register(path, { kind: 'hydration', seq: 14, hash: 'new' });
    expect(effects.isCancelled(old)).toBe(true);
    expect(effects.isCancelled(upload)).toBe(false); expect(effects.isCancelled(newer)).toBe(false);
    effects.settle(old); expect(effects.isCancelled(old)).toBe(false);
    effects.settle(upload); effects.settle(newer); expect(effects.pending(path)).toBe(false);
    expect(newer).toBeGreaterThan(old);
  });
  it.each(['waiting', 'executing'])('republish cancellation while %s skips or compensates', async schedule => {
    const s = rig(); s.live(12, svg);
    s.index.update(path, { pendingDecision: { kind: 'republish', seq: 12, generation: 3 } });
    const lock = held();
    const blocker = schedule === 'waiting' ? s.uploader.pathEffects.withPathLock(path, () => lock.promise) : Promise.resolve();
    const work = s.uploader.reconcilePendingDeletes(true);
    if (schedule === 'executing') await s.started.promise;
    else await drain();
    s.disk.delete(path); const deletion = s.uploader.onFileDeleted(path);
    lock.resolve(); s.gate.resolve();
    await Promise.all([blocker, work, deletion]);
    expect(s.disk.has(path)).toBe(false); expect(s.index.get(path)).toBeUndefined();
    expect(s.writes).toHaveBeenCalledTimes(schedule === 'waiting' ? 0 : 1);
    expect(s.trash).toHaveBeenCalledTimes(schedule === 'waiting' ? 0 : 1);
    expect(s.uploader.pathEffects.pending(path)).toBe(false);
  });
  it('combined lock-honest cancellation 12 and waiting hydration 14 survives compensation echo', async () => {
    const s = rig(); s.live(12, svg);
    s.index.update(path, { pendingDecision: { kind: 'republish', seq: 12, generation: 3 } });
    const old = s.internal.canonicalSvgBytes(path, svg, () => !!s.index.get(path)?.pendingDecision, { kind: 'decision', seq: 12 });
    await s.started.promise;
    s.disk.delete(path); const deletion = s.uploader.onFileDeleted(path);
    s.live(14); const hydration = s.downloader.hydrateOne(path);
    await drain(); expect(s.writes).toHaveBeenCalledTimes(1);
    s.gate.resolve(); await Promise.all([old, deletion, hydration]);
    expect(s.trash).toHaveBeenCalledTimes(1); expect(s.post).toHaveBeenCalledTimes(1);
    expect(s.disk.has(path)).toBe(true); expect(s.index.get(path)).toMatchObject({ seq: 14, hydrated: true });
    expect(s.uploader.pathEffects.pending(path)).toBe(false);
    s.index.update(path, { hydrated: false }); await s.downloader.hydrateOne(path);
    expect(s.disk.has(path)).toBe(true); expect(s.trash).toHaveBeenCalledTimes(1);
  });
  it.each(['ordinary', 'post-held', 'entry-absent'])('held hydration compensates %s deletion without recreation', async schedule => {
    const s = rig(); s.live(10); const postGate = held();
    if (schedule === 'post-held') s.post.mockImplementation(async () => { await postGate.promise; return { status: 200, json: { accepted: true } }; });
    const hydration = s.downloader.hydrateOne(path); await s.started.promise;
    s.disk.delete(path);
    const deletion = schedule === 'entry-absent' ? Promise.resolve(s.index.remove(path)) : s.uploader.onFileDeleted(path);
    if (schedule === 'post-held') { await drain(); expect(s.index.get(path)).toBeDefined(); }
    if (schedule === 'ordinary') { await deletion; expect(s.index.get(path)).toBeUndefined(); }
    s.gate.resolve(); await hydration;
    expect(s.disk.has(path)).toBe(false); expect(s.trash).toHaveBeenCalledTimes(1);
    postGate.resolve(); await deletion;
    expect(s.index.get(path)).toBeUndefined(); expect(s.disk.size).toBe(0);
  });
  it.each([true, false])('first-upload write cancellation=%s uses explicit token, not entry absence', async cancel => {
    const s = rig();
    const http = vi.spyOn(s.internal, 'http').mockResolvedValue({ status: 200,
      json: { exists: true, accepted: true, seq: 1 } });
    s.uploader.onFileChanged(path); await s.started.promise;
    if (cancel) { s.disk.delete(path); await s.uploader.onFileDeleted(path); }
    s.gate.resolve(); await s.uploader.flush();
    expect(s.disk.has(path)).toBe(!cancel);
    expect(s.trash).toHaveBeenCalledTimes(cancel ? 1 : 0);
    expect(http).toHaveBeenCalledTimes(cancel ? 0 : 2);
    if (cancel) expect(s.index.get(path)).toBeUndefined();
    else expect(s.index.get(path)).toMatchObject({ seq: 1, hydrated: true });
  });
  it.each(['indexed', 'appears'])('upload-owned write with entry %s remains normal', async schedule => {
    const s = rig(); if (schedule === 'indexed') s.live(10, svg);
    const work = s.internal.canonicalSvgBytes(path, svg); await s.started.promise;
    s.live(14); s.gate.resolve();
    expect(await work).not.toBeNull(); expect(s.trash).not.toHaveBeenCalled();
    expect(s.disk.has(path)).toBe(true);
  });
  it('newer authority supersedes hydration without deleting bytes or posting a tombstone', async () => {
    const s = rig(); s.live(10); const hydration = s.downloader.hydrateOne(path); await s.started.promise;
    s.live(14); s.gate.resolve(); await hydration;
    expect(s.disk.has(path)).toBe(true); expect(s.index.get(path)).toMatchObject({ seq: 14, hydrated: false });
    expect(s.trash).not.toHaveBeenCalled(); expect(s.post).not.toHaveBeenCalled();
  });
  it('decision lane and effect lock finish in one microtask drain without a self-join', async () => {
    const s = rig(); s.live(12, svg);
    s.index.update(path, { pendingDecision: { kind: 'republish', seq: 12, generation: 3 } });
    vi.spyOn(s.internal, 'http').mockResolvedValue({ status: 200, json: { exists: true, states: [], max_seq: 0 } });
    const lane = s.uploader.reconcilePendingDeletes(true);
    await s.started.promise;
    let done = false;
    const catchup = s.uploader.catchUp();
    const lock = s.uploader.pathEffects.withPathLock(path, async () => {});
    s.gate.resolve();
    void Promise.all([lane, catchup, lock]).then(() => { done = true; });
    await drain(); expect(done).toBe(true);
  });
  it('upload supersession stops without compensation, and hydration hash changes supersede', async () => {
    const s = rig(); s.live(10);
    const trash = vi.fn(async () => {});
    const effects = new PathEffects(s.index, trash, () => true);
    const upload = effects.register(path, { kind: 'upload' });
    expect(await effects.classify(upload)).toBe('stop'); effects.settle(upload);
    const hydration = effects.register(path, { kind: 'hydration', seq: 10, hash: s.index.get(path)!.hash });
    s.index.update(path, { hash: 'changed' });
    expect(await effects.classify(hydration)).toBe('supersession'); effects.settle(hydration);
    expect(trash).not.toHaveBeenCalled();
  });
});
