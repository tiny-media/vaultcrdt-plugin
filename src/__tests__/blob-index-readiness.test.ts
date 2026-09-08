import { beforeEach, describe, expect, it, vi } from 'vitest';
const { canonical } = vi.hoisted(() => ({ canonical: vi.fn() }));
vi.mock('../../wasm/vaultcrdt_wasm', () => ({ blob_path_key: canonical }));
import { BlobIndex } from '../blob-index';

const path = 'vcrdt-t-image.png';
const candidate = { v: 1, maxSeq: 9, paths: { [path]: { key: path, hash: '' } } };
function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(raw: unknown) {
  let bytes = JSON.stringify(raw);
  const read = vi.fn(() => JSON.parse(bytes) as unknown);
  const store = {
    read,
    loadJson: async <T,>() => read() as T,
    saveJson: vi.fn(async () => undefined),
  };
  return { store, index: new BlobIndex(store), bytes: () => bytes,
    replace: (next: unknown) => { bytes = JSON.stringify(next); } };
}
beforeEach(() => { canonical.mockReset().mockImplementation((p: string) => p); });

describe('BlobIndex cold readiness boundary (export spy, not path-policy oracle)', () => {
  it('reads once and awaits readiness before any export or admission', async () => {
    const { index, store } = setup(candidate);
    const gate = deferred();
    const ready = vi.fn(() => gate.promise);
    const loading = index.load(ready);
    await Promise.resolve();
    expect(ready).toHaveBeenCalledTimes(1);
    expect(canonical).not.toHaveBeenCalled();
    expect(index.entries()).toEqual([]);
    expect(index.maxSeq()).toBe(0);
    gate.resolve();
    await loading;
    expect(canonical).toHaveBeenCalledExactlyOnceWith(path);
    expect(index.get(path)?.key).toBe(path);
    expect(store.read).toHaveBeenCalledTimes(1);
    expect(store.saveJson).not.toHaveBeenCalled();
  });

  it.each([
    null, 'vcrdt-t-malformed', 1, {}, [], { v: 2, paths: candidate.paths },
    { v: 1, paths: 'vcrdt-t-malformed' }, { v: 1, paths: [] },
    { v: 1, paths: {} }, { v: 1, paths: { [path]: null } },
    { v: 1, paths: { [path]: { key: 3, hash: '' } } },
    { v: 1, paths: { [path]: { key: path, hash: 3 } } },
    { v: 1, paths: { [path]: [] } },
  ].map((raw) => [raw]))('skips readiness and exports for absent/empty/malformed candidates: %j', async (raw) => {
    const { index, store } = setup(raw);
    const ready = vi.fn(async () => { throw new Error('must stay lazy'); });
    await index.load(ready);
    expect(ready).not.toHaveBeenCalled();
    expect(canonical).not.toHaveBeenCalled();
    expect(index.entries()).toEqual([]);
    expect(store.saveJson).not.toHaveBeenCalled();
  });

  it('awaits readiness even when all candidates are ultimately rejected; preserves maxSeq', async () => {
    const { index } = setup(candidate);
    canonical.mockReturnValue(undefined);
    const ready = vi.fn(async () => { expect(canonical).not.toHaveBeenCalled(); });
    await index.load(ready);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(canonical).toHaveBeenCalledExactlyOnceWith(path);
    expect(index.entries()).toEqual([]);
    expect(index.maxSeq()).toBe(9);
  });

  it('rejects array containers/entries even with attached candidate fields; ignores inherited paths', async () => {
    const arrayEntry = Object.assign([], { key: path, hash: '' });
    const rawCases = [
      Object.assign([], candidate),
      { v: 1, paths: Object.assign([], candidate.paths) },
      { v: 1, paths: { [path]: arrayEntry } },
      { v: 1, paths: Object.create(candidate.paths) },
    ];
    for (const raw of rawCases) {
      const index = new BlobIndex({ loadJson: async <T,>() => raw as T, saveJson: vi.fn() });
      const ready = vi.fn(async () => undefined);
      await index.load(ready);
      expect(ready).not.toHaveBeenCalled();
      expect(index.entries()).toEqual([]);
    }
    expect(canonical).not.toHaveBeenCalled();
  });

  it('propagates readiness failure without replacing prior state or storage; retry reads fresh bytes', async () => {
    const fixture = setup(candidate);
    const { index, store } = fixture;
    await index.load(async () => undefined);
    const previous = index.entries();
    const oldEntry = index.get(path);
    const nextPath = 'vcrdt-t-next.png';
    fixture.replace({ v: 1, maxSeq: 20, paths: { [nextPath]: { key: nextPath, hash: '' } } });
    const stored = fixture.bytes();
    canonical.mockClear();
    const gate = deferred();
    const failure = new Error('vcrdt-t-readiness-failed');
    const ready = vi.fn(() => gate.promise);
    const result = index.load(ready).then(() => undefined, (err: unknown) => err);
    await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
    gate.reject(failure);
    expect(await result).toBe(failure);
    expect(index.entries()).toEqual(previous);
    expect(index.get(path)).toBe(oldEntry);
    expect(index.maxSeq()).toBe(9);
    expect(fixture.bytes()).toBe(stored);
    expect(canonical).not.toHaveBeenCalled();
    expect(store.saveJson).not.toHaveBeenCalled();
    fixture.replace({ ...candidate, maxSeq: 30 });
    await index.load(async () => undefined);
    expect(index.get(nextPath)).toBeUndefined();
    expect(index.maxSeq()).toBe(30);
    expect(store.read).toHaveBeenCalledTimes(3);
    expect(store.saveJson).not.toHaveBeenCalled();
  });
});
