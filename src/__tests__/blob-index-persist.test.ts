import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../wasm/vaultcrdt_wasm', () => ({ blob_path_key: (p: string) => p.endsWith('.png') ? p.toLowerCase() : undefined }));
import { BlobIndex, validateIndexFile, type BlobIndexStorage } from '../blob-index';

const MAIN = 'blob-index.json', BAK = 'blob-index.bak', BAD = 'blob-index.corrupt.json';
const ready = async () => {};
const snapshot = (maxSeq = 1) => JSON.stringify({ v: 1, maxSeq, paths: {} });
const entry = { key: 'a.png', hash: '' };
const withEntry = (e: unknown) => JSON.stringify({ v: 1, maxSeq: 8, paths: { 'valid.png': { key: 'valid.png', hash: '' }, 'a.png': e } });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
const indexes: BlobIndex[] = [];
function rig(main: string | null = snapshot(), backup: string | null = null) {
  const files = new Map<string, string>();
  if (main !== null) files.set(MAIN, main);
  if (backup !== null) files.set(BAK, backup);
  const ops: string[] = [];
  const store = {
    existsRaw: vi.fn(async (n: string) => { ops.push(`exists:${n}`); return files.has(n); }),
    readRaw: vi.fn(async (n: string) => { ops.push(`read:${n}`); return files.get(n) ?? null; }),
    writeRaw: vi.fn(async (n: string, s: string) => { ops.push(`write:${n}`); files.set(n, s); }),
    loadJson: vi.fn(async <T,>(): Promise<T | null> => null) as unknown as BlobIndexStorage["loadJson"],
    saveJson: vi.fn(async () => {}),
  };
  const create = () => { const i = new BlobIndex(store); indexes.push(i); return i; };
  return { files, ops, store, index: create(), create };
}
async function drained(index: BlobIndex) {
  // Observe the original task without flush's sanctioned retry.
  await (index as unknown as { writes: Promise<void> }).writes;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', globalThis);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  indexes.splice(0).forEach(i => i.dispose());
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('strict snapshot validator', () => {
  it.each([
    '{', 'null', '[]', '1', '"text"', '{}',
    JSON.stringify({ v: 2, maxSeq: 0, paths: {} }),
    JSON.stringify({ v: 1, paths: {} }),
    JSON.stringify({ v: 1, maxSeq: 0 }),
    JSON.stringify({ maxSeq: 0, paths: {} }),
    ...[null, [], 2, 'paths'].map(paths => JSON.stringify({ v: 1, maxSeq: 0, paths })),
    ...[null, '8', false].map(maxSeq => JSON.stringify({ v: 1, maxSeq, paths: {} })),
    ...[null, [], 7, {}, { key: 1, hash: '' }, { key: 'a.png', hash: 1 }, { key: 'wrong.png', hash: '' }].map(withEntry),
    ...['size', 'generation', 'seq', 'mtime', 'hydrated', 'skipped', 'lastRemoteHash'].flatMap(field =>
      [[], {}, 'wrong', null].filter(v => field !== 'lastRemoteHash' || (v !== null && typeof v !== 'string'))
        .map(value => withEntry({ ...entry, [field]: value }))),
    withEntry({ ...entry, lastRemoteHash: 3 }),
  ])('rejects entire snapshot: %s', async raw => {
    expect((await validateIndexFile(raw)).ok).toBe(false);
  });
  it('defaults only missing fields; preserves legal negative numbers and null remote hash', async () => {
    const result = await validateIndexFile(withEntry(entry));
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error(result.reason);
    expect(result.file.paths['a.png']).toEqual({ ...entry, size: 0, generation: 0, seq: 0, hydrated: true, lastRemoteHash: '' });
    expect(result.file.maxSeq).toBe(8);
    expect((await validateIndexFile(withEntry({ ...entry, size: -1, generation: -2, seq: -3, mtime: -4, hydrated: false, skipped: true, lastRemoteHash: null }))).ok).toBe(true);
  });
});

describe('exclusive load and recovery outcomes', () => {
  it.each([
    [snapshot(8), null, 'ok', 8],
    ['{', snapshot(7), 'recovered', 7],
    [null, snapshot(7), 'recovered', 7],
    [null, null, 'fresh', 0],
    [null, '{', 'poisoned', 0],
    ['{', '{', 'poisoned', 0],
    ['{', null, 'poisoned', 0],
  ] as const)('main=%s bak=%s -> %s', async (main, bak, outcome, seq) => {
    const r = rig(main, bak);
    const result = await r.index.load(ready);
    expect(result.outcome).toBe(outcome);
    expect(r.index.poisoned()).toBe(outcome === 'poisoned');
    expect(r.index.maxSeq()).toBe(seq);
    expect(r.index.entries()).toEqual([]);
    expect(result.quarantine).toBe(main === '{' ? BAD : undefined);
    expect(r.files.get(BAD)).toBe(main === '{' ? main : undefined);
    if (outcome === 'recovered') expect(r.files.get(MAIN)).toBe(bak);
    expect(r.files.get(BAK)).toBe(bak ?? undefined);
  });
  it('backup uses the same whole-snapshot validator and carries paths with its cursor', async () => {
    const r = rig(null, withEntry(entry));
    expect((await r.index.load(ready)).outcome).toBe('recovered');
    expect(r.index.get('a.png')?.hash).toBe(''); expect(r.index.maxSeq()).toBe(8);
    expect(r.files.get(MAIN)).toBe(withEntry(entry));
    r.files.delete(MAIN); r.files.set(BAK, withEntry({ ...entry, hydrated: 'wrong' }));
    expect((await r.index.load(ready)).outcome).toBe('poisoned');
    expect(r.index.entries()).toEqual([]); expect(r.index.maxSeq()).toBe(0);
    expect(r.files.has(MAIN)).toBe(false);
  });
  it('load waits for a previously queued persist and admits its newest state', async () => {
    const r = rig(); await r.index.load(ready); r.ops.length = 0;
    const gate = deferred();
    r.store.writeRaw.mockImplementationOnce(async (n, s) => {
      r.ops.push(`held:${n}`); await gate.promise; r.files.set(n, s);
    });
    r.index.noteMaxSeq(2);
    const loading = r.index.load(ready);
    await vi.waitFor(() => expect(r.ops).toEqual([`read:${MAIN}`, `held:${BAK}`]));
    gate.resolve(); expect((await loading).outcome).toBe('ok');
    expect(r.ops).toEqual([`read:${MAIN}`, `held:${BAK}`, `read:${BAK}`, `write:${MAIN}`, `read:${MAIN}`, `read:${MAIN}`]);
    expect(r.index.maxSeq()).toBe(2); expect(r.files.get(MAIN)).toBe(snapshot(2));
  });
  it('quarantine failure only warns and never claims a diagnostic', async () => {
    const r = rig('{');
    r.store.writeRaw.mockRejectedValueOnce(Error('quarantine unavailable'));
    expect(await r.index.load(ready)).toMatchObject({ outcome: 'poisoned', quarantine: undefined });
    expect(r.index.poisoned()).toBe(true);
    expect(r.files.has(BAD)).toBe(false);
    expect(console.warn).toHaveBeenCalled();
  });
  it.each([MAIN, BAK])('read errors for %s reject rather than fresh/poison', async name => {
    const r = rig(null);
    r.store.readRaw.mockImplementation(async n => { if (n === name) throw Error('read denied'); return null; });
    await expect(r.index.load(ready)).rejects.toThrow('read denied');
    expect(r.index.poisoned()).toBe(false);
    expect(r.store.writeRaw).not.toHaveBeenCalled();
  });
  it('failed self-heal retains validated backup memory and retries without poisoning', async () => {
    const r = rig(null, snapshot(7));
    r.store.writeRaw.mockRejectedValueOnce(Error('repair denied'));
    expect((await r.index.load(ready)).outcome).toBe('recovered');
    expect(r.index.maxSeq()).toBe(7);
    expect(r.index.poisoned()).toBe(false);
    expect(r.index.lastPersistError).toContain('main-restore');
    await r.index.flush();
    expect(r.files.get(MAIN)).toBe(snapshot(7));
    expect(r.index.lastPersistError).toBeNull();
  });
  it('sticky poison clears only with a valid restored snapshot', async () => {
    const r = rig('{');
    await r.index.load(ready);
    r.files.clear();
    expect((await r.index.load(ready)).outcome).toBe('poisoned');
    r.files.set(MAIN, snapshot(10));
    expect((await r.index.load(ready)).outcome).toBe('ok');
    expect(r.index.poisoned()).toBe(false);
    r.index.noteMaxSeq(11); await r.index.flush();
    expect(JSON.parse(r.files.get(MAIN)!).maxSeq).toBe(11);
  });
  it('load is a FIFO task: later persists cannot interleave repair reads/writes', async () => {
    const r = rig(null, snapshot(7));
    const gate = deferred();
    r.store.readRaw.mockImplementationOnce(async n => { r.ops.push(`held:${n}`); await gate.promise; return null; });
    const loading = r.index.load(ready);
    r.index.noteMaxSeq(9);
    await Promise.resolve();
    expect(r.ops).toEqual([`held:${MAIN}`]);
    gate.resolve(); await loading; await r.index.flush();
    expect(r.ops).toEqual([`held:${MAIN}`, `read:${BAK}`, `write:${MAIN}`, `read:${MAIN}`,
      `read:${MAIN}`, `write:${BAK}`, `read:${BAK}`, `write:${MAIN}`, `read:${MAIN}`]);
    expect(r.index.maxSeq()).toBe(9);
    expect(JSON.parse(r.files.get(MAIN)!).maxSeq).toBe(9);
  });
  it('reload-discard guard preserves A+B in memory/disk and subsequent A+B+C', async () => {
    const r = rig(withEntry(entry));
    await r.index.load(ready);
    const loading = r.index.load(ready);
    r.index.update('b.png', { hash: 'B', seq: 9 });
    await loading; await r.index.flush();
    expect(r.index.entries().map(([p]) => p)).toEqual(['valid.png', 'a.png', 'b.png']);
    expect(JSON.parse(r.files.get(MAIN)!).paths['b.png'].hash).toBe('B');
    r.index.update('c.png', { hash: 'C', seq: 10 }); await r.index.flush();
    expect(Object.keys(JSON.parse(r.files.get(MAIN)!).paths)).toEqual(['valid.png', 'a.png', 'b.png', 'c.png']);
    expect(r.index.entries().map(([p]) => p)).toEqual(['valid.png', 'a.png', 'b.png', 'c.png']);
    expect(r.index.maxSeq()).toBe(10);
  });
  it('poison overrides newer mutations; queued persist/retry and poisoned mutators write nothing', async () => {
    const r = rig(withEntry(entry));
    await r.index.load(ready);
    r.index.lastPersistError = 'prior failure';
    r.files.set(MAIN, '{'); r.files.set(BAK, '{');
    const loading = r.index.load(ready);
    r.index.update('b.png', { hash: 'B', seq: 12 });
    const retry = (r.index as unknown as { retry(): Promise<void> }).retry().catch(() => {});
    await loading; await retry;
    expect(r.index.poisoned()).toBe(true);
    expect(r.index.entries()).toEqual([]); expect(r.index.maxSeq()).toBe(0);
    const mutations = (r.index as unknown as { mutations: number }).mutations;
    r.index.update('c.png', {}); r.index.move('a.png', 'b.png'); r.index.remove('a.png'); r.index.noteMaxSeq(20);
    expect((r.index as unknown as { mutations: number }).mutations).toBe(mutations);
    expect(r.store.writeRaw.mock.calls.map(([n]) => n)).toEqual([BAD]);
  });
  it('recovered state is visible while the repair write is pending; mutations compose onto it', async () => {
    const r = rig(null, withEntry(entry));
    const gate = deferred();
    r.store.writeRaw.mockImplementationOnce(async (n: string, s: string) => { await gate.promise; r.files.set(n, s); });
    const loading = r.index.load(ready);
    await vi.waitFor(() => expect(r.store.writeRaw).toHaveBeenCalled());
    // Publish-before-repair: the recovered snapshot is visible DURING the
    // pending repair I/O, not only after it settles.
    expect(r.index.maxSeq()).toBe(8);
    expect(r.index.get('a.png')).toBeDefined();
    // A mutation in the repair window composes onto the recovered state.
    r.index.update('a.png', { hash: 'B2' });
    gate.resolve(); await loading; await r.index.flush();
    expect(r.index.get('a.png')?.hash).toBe('B2');
    expect(JSON.parse(r.files.get(MAIN)!).paths['a.png'].hash).toBe('B2');
  });
  it('restart at a torn repair boundary recovers from frozen backup after old writer stops', async () => {
    const r = rig('{', snapshot(7));
    const gate = deferred();
    r.store.writeRaw.mockImplementationOnce(async (n, s) => { r.files.set(n, s); }); // quarantine
    r.store.writeRaw.mockImplementationOnce(async n => { r.files.set(n, '{'); await gate.promise; throw Error('crash'); });
    const loading = r.index.load(ready);
    await vi.waitFor(() => expect(r.store.writeRaw).toHaveBeenCalledTimes(2));
    expect(r.files.get(BAK)).toBe(snapshot(7));
    r.index.dispose(); gate.resolve(); await loading; // old writer cannot continue after restart
    const restarted = r.create();
    expect((await restarted.load(ready)).outcome).toBe('recovered');
    expect(restarted.maxSeq()).toBe(7); expect(r.files.get(MAIN)).toBe(snapshot(7));
  });
});

describe('verified two-write persistence and retry', () => {
  it('rotates exact previous bytes before newest snapshot, with exact readbacks', async () => {
    const old = '{ "v":1, "maxSeq":1, "paths":{} }';
    const r = rig(old); await r.index.load(ready); r.ops.length = 0;
    r.index.noteMaxSeq(2); await r.index.flush();
    expect(r.store.writeRaw.mock.calls).toEqual([[BAK, old], [MAIN, snapshot(2)]]);
    expect(r.ops).toEqual([`read:${MAIN}`, `write:${BAK}`, `read:${BAK}`, `write:${MAIN}`, `read:${MAIN}`]);
  });
  it('backup write failure leaves main untouched; flush rejects while failure stands', async () => {
    const r = rig(); await r.index.load(ready);
    r.store.writeRaw.mockRejectedValue(Error('denied'));
    r.index.noteMaxSeq(2); await drained(r.index);
    expect(r.index.lastPersistError).toContain('bak'); expect(console.warn).toHaveBeenCalled();
    expect(r.files.get(MAIN)).toBe(snapshot());
    await expect(r.index.flush()).rejects.toThrow('bak');
    expect(r.store.writeRaw.mock.calls.map(([n]) => n)).toEqual([BAK, BAK]);
  });
  it.each(['torn', 'old', 'new'])('failed main leaves %s bytes; retry revalidates before rotating', async mode => {
    const r = rig(); await r.index.load(ready);
    const normal = r.store.writeRaw.getMockImplementation()!;
    r.store.writeRaw.mockImplementation(async (n, s) => {
      if (n === MAIN) {
        if (mode !== 'old') r.files.set(n, mode === 'torn' ? '{' : s);
        throw Error('main failed');
      }
      await normal(n, s);
    });
    r.index.noteMaxSeq(2); await drained(r.index);
    expect(r.index.lastPersistError).toContain('main'); expect(r.files.get(BAK)).toBe(snapshot());
    r.store.writeRaw.mockClear().mockImplementation(normal);
    await r.index.flush();
    expect(r.store.writeRaw.mock.calls).toEqual(mode === 'torn'
      ? [[MAIN, snapshot()], [BAK, snapshot()], [MAIN, snapshot(2)]]
      : [[BAK, snapshot(mode === 'new' ? 2 : 1)], [MAIN, snapshot(2)]]);
    expect(r.index.lastPersistError).toBeNull(); expect(r.files.get(MAIN)).toBe(snapshot(2));
  });
  it.each(['{', snapshot(99)])('successful write with invalid OR unequal readback fails: %s', async wrong => {
    const r = rig(); await r.index.load(ready);
    r.store.writeRaw.mockImplementation(async (n, s) => { r.files.set(n, n === MAIN ? wrong : s); });
    r.index.noteMaxSeq(2); await drained(r.index);
    expect(r.index.lastPersistError).toContain('main'); expect(r.files.get(BAK)).toBe(snapshot());
  });
  it.each(['{', snapshot(99)])('invalid or unequal backup readback aborts before touching main: %s', async wrong => {
    const r = rig(); await r.index.load(ready);
    r.store.writeRaw.mockImplementation(async n => { r.files.set(n, wrong); });
    r.index.noteMaxSeq(2); await drained(r.index);
    expect(r.index.lastPersistError).toContain('bak'); expect(r.files.get(MAIN)).toBe(snapshot());
    expect(r.store.writeRaw.mock.calls.map(([n]) => n)).toEqual([BAK]);
  });
  it('torn first write has no backup: restart is empty AND poisoned, never fresh', async () => {
    const r = rig(null); await r.index.load(ready);
    r.store.writeRaw.mockImplementationOnce(async n => { r.files.set(n, '{'); });
    r.index.noteMaxSeq(2); await drained(r.index); r.index.dispose();
    expect(r.files.has(BAK)).toBe(false);
    const restarted = r.create();
    expect((await restarted.load(ready)).outcome).toBe('poisoned');
    expect(restarted.entries()).toEqual([]); expect(restarted.maxSeq()).toBe(0); expect(restarted.poisoned()).toBe(true);
  });
  it('repeated failed restores never rotate backup; later repair converges', async () => {
    const r = rig(); await r.index.load(ready);
    r.files.set(MAIN, '{'); r.files.set(BAK, snapshot());
    const normal = r.store.writeRaw.getMockImplementation()!;
    r.store.writeRaw.mockRejectedValue(Error('restore failed'));
    r.index.noteMaxSeq(2); await drained(r.index);
    await expect(r.index.flush()).rejects.toThrow('main-restore');
    await expect(r.index.flush()).rejects.toThrow('main-restore');
    expect(r.store.writeRaw.mock.calls.map(([n]) => n)).toEqual([MAIN, MAIN, MAIN]);
    expect(r.files.get(BAK)).toBe(snapshot());
    r.store.writeRaw.mockImplementation(normal); await r.index.flush();
    expect(r.files.get(MAIN)).toBe(snapshot(2)); expect(r.files.get(BAK)).toBe(snapshot());
  });
  it('persist read rejection surfaces an error without taking the fresh branch', async () => {
    const r = rig(null); await r.index.load(ready);
    r.store.readRaw.mockRejectedValueOnce(Error('read denied'));
    r.index.noteMaxSeq(2); await drained(r.index);
    expect(r.index.lastPersistError).toContain('read denied');
    expect(r.store.writeRaw).not.toHaveBeenCalled();
    await r.index.flush(); expect(r.files.get(MAIN)).toBe(snapshot(2));
  });
  it('no valid snapshot fails without writing anything', async () => {
    const r = rig(); await r.index.load(ready); r.files.set(MAIN, '{');
    r.index.noteMaxSeq(2); await drained(r.index);
    expect(r.index.lastPersistError).toContain('no-valid-snapshot'); expect(r.store.writeRaw).not.toHaveBeenCalled();
  });
  it('flush rejects while poisoned with a standing persist error (uploader shutdown path)', async () => {
    const r = rig(withEntry(entry));
    await r.index.load(ready);
    r.store.writeRaw.mockRejectedValue(new Error('io'));
    r.index.update('a.png', { hash: 'x' });
    await drained(r.index);
    expect(r.index.lastPersistError).toBeTruthy();
    r.files.set(MAIN, '{');
    expect((await r.index.load(ready)).outcome).toBe('poisoned');
    await expect(r.index.flush()).rejects.toThrow();
  });
  it('concurrent flush callers serialize one effective idempotent retry', async () => {
    const r = rig(); await r.index.load(ready);
    r.store.writeRaw.mockRejectedValueOnce(Error('temporary'));
    r.index.noteMaxSeq(2); await drained(r.index); r.store.writeRaw.mockClear();
    const gate = deferred();
    r.store.writeRaw.mockImplementationOnce(async (n, s) => { await gate.promise; r.files.set(n, s); });
    let done = 0;
    const a = r.index.flush().then(() => { done++; }); const b = r.index.flush().then(() => { done++; });
    await vi.waitFor(() => expect(r.store.writeRaw).toHaveBeenCalledTimes(1));
    expect(done).toBe(0); gate.resolve(); await Promise.all([a, b]);
    expect(done).toBe(2); expect(r.store.writeRaw.mock.calls.map(([n]) => n)).toEqual([BAK, MAIN]);
    expect(r.index.lastPersistError).toBeNull();
  });
  it('single 30s timer repeats without external events and clears on success', async () => {
    const r = rig(); await r.index.load(ready);
    const normal = r.store.writeRaw.getMockImplementation()!;
    r.store.writeRaw.mockRejectedValue(Error('offline'));
    r.index.noteMaxSeq(2); r.index.noteMaxSeq(3); await drained(r.index);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(29_999); expect(r.store.writeRaw).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(r.store.writeRaw).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);
    r.store.writeRaw.mockImplementation(normal);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(r.files.get(MAIN)).toBe(snapshot(3)); expect(r.index.lastPersistError).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  });
  it('dispose clears timer and pending late failures cannot rearm', async () => {
    const r = rig(); await r.index.load(ready);
    r.store.writeRaw.mockRejectedValueOnce(Error('fail'));
    r.index.noteMaxSeq(2); await drained(r.index); expect(vi.getTimerCount()).toBe(1);
    const gate = deferred();
    r.store.writeRaw.mockImplementationOnce(async () => { await gate.promise; throw Error('late'); });
    r.index.noteMaxSeq(3); await Promise.resolve(); r.index.dispose(); gate.resolve(); await drained(r.index);
    expect(vi.getTimerCount()).toBe(0);
    const calls = r.store.writeRaw.mock.calls.length; await vi.advanceTimersByTimeAsync(90_000);
    expect(r.store.writeRaw).toHaveBeenCalledTimes(calls);
  });
  it.each(['flush', 'timer'])('FIFO newest snapshot wins across an intervening %s retry', async trigger => {
    const r = rig(); await r.index.load(ready);
    r.store.writeRaw.mockRejectedValueOnce(Error('temporary'));
    r.index.noteMaxSeq(2); await drained(r.index);
    const gate = deferred();
    r.store.writeRaw.mockImplementationOnce(async (n, s) => { await gate.promise; r.files.set(n, s); });
    const retry = trigger === 'flush' ? r.index.flush() : vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(r.store.writeRaw).toHaveBeenCalledTimes(2));
    r.index.noteMaxSeq(3); r.index.noteMaxSeq(4);
    gate.resolve(); await retry; await r.index.flush();
    expect(r.files.get(MAIN)).toBe(snapshot(4)); expect(r.files.get(BAK)).toBe(snapshot(3)); expect(r.index.maxSeq()).toBe(4);
    expect(r.store.writeRaw.mock.calls.filter(([n]) => n === MAIN).map(([, s]) => JSON.parse(s).maxSeq)).toEqual([2, 3, 4]);
  });
});
