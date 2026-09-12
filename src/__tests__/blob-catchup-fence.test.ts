import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import init from '../../wasm/vaultcrdt_wasm';
import { BlobIndex } from '../blob-index';
import { BlobUploader } from '../blob-uploader';

beforeAll(async () => { await init({ module_or_path: readFileSync(new URL('../../wasm/vaultcrdt_wasm_bg.wasm', import.meta.url)) }); });
function setup(pages: Record<string, unknown>[]) {
  const files = new Map<string, string>();
  const storage = { existsRaw: async (name: string) => files.has(name), readRaw: async (name: string) => files.get(name) ?? null,
    writeRaw: vi.fn(async (name: string, text: string) => { files.set(name, text); }), loadJson: async () => null, saveJson: async () => {} };
  const index = new BlobIndex(storage);
  const uploader = new BlobUploader({ listFiles: async () => [], index, serverUrl: () => '', peerId: () => '', getJwt: async () => '',
    blobsEnabled: async () => true, stat: async () => null, readBinary: async () => new ArrayBuffer(0),
    writeBinary: async () => {}, notify: () => {}, isMobile: false });
  const http = vi.spyOn(uploader as unknown as { http: (...args: unknown[]) => Promise<{ json: unknown }> }, 'http').mockImplementation(async () => ({ json: pages.shift() }));
  return { index, uploader, http, storage };
}
const row = (seq: number) => ({ seq, state: 'live', path_key: 'ignored' });
describe('fixed fence', () => {
  it.each([false, true])('settlement alone rearms once, including teardown=%s', async teardown => {
    const { index, uploader, http } = setup([]);
    // Isolate settlement rearming from the independent missed-delete backstop.
    vi.spyOn(uploader, 'sweepAttachments').mockResolvedValue();
    index.update('a.png', { seq: 0, hash: 'x' });
    const state = { seq: 2, state: 'deleted', path_key: index.get('a.png')!.key };
    http.mockImplementation(async () => ({ json: { max_seq: 2, states: [row(1), state] } }));
    const internals = uploader as any;
    internals.queued.add('a.png');
    if (teardown) {
      const original = index.flush.bind(index);
      vi.spyOn(index, 'flush').mockImplementationOnce(async () => {
        internals.dropQueued('a.png');
        await original();
      });
    }
    await uploader.catchUp();
    if (!teardown) {
      expect(index.cursor()).toBe(1);
      for (let i = 0; i < 30; i++) await Promise.resolve();
      expect(http).toHaveBeenCalledTimes(1);
      internals.dropQueued('a.png');
    }
    for (let i = 0; i < 60; i++) await Promise.resolve();
    expect(http).toHaveBeenCalledTimes(2);
    expect(index.cursor()).toBe(2);
    expect(index.get('a.png')).toBeUndefined();
  });

  it('walks full pages and freezes the first fence', async () => {
    const { index, uploader, http } = setup([
      { max_seq: 1002, states: Array.from({ length: 1000 }, (_, i) => row(i + 1)) },
      { max_seq: 2000, states: [row(1001), row(1003)] },
    ]);
    await uploader.catchUp();
    expect(index.cursor()).toBe(1002);
    expect(http.mock.calls.map(c => c[1])).toEqual(['/vault/blob-paths?since_seq=0&limit=1000', '/vault/blob-paths?since_seq=1000&limit=1000']);
  });
  it.each([
    { states: null, max_seq: 10 },
    ...['10', -1, 1.5, null].map(max_seq => ({ states: [row(1)], max_seq })),
    { states: [] },
  ])('does not certify malformed or absent empty envelope %j', async page => {
    const { index, uploader } = setup([page]);
    await uploader.catchUp();
    expect(index.cursor()).toBe(0);
  });
  it.each([
    [{ states: [row(2)] }, 2],
    [{ states: [row(2)], max_seq: 9 }, 9],
    [{ states: [], max_seq: 9 }, 9],
    [{ states: [row(9)], max_seq: 9 }, 9],
    [{ states: [], max_seq: 0 }, 0],
  ] as const)('terminates %j', async (page, cursor) => {
    const { index, uploader, http } = setup([page]);
    await uploader.catchUp();
    expect(index.cursor()).toBe(cursor);
    expect(http).toHaveBeenCalledTimes(1);
  });
  it('does not certify a failed flush; retry certifies', async () => {
    const { index, uploader, storage } = setup([{ states: [], max_seq: 8 }, { states: [], max_seq: 8 }]);
    index.update('a.png', { seq: 1 });
    const write = vi.spyOn(storage, 'writeRaw').mockRejectedValue(new Error('disk'));
    await expect(uploader.catchUp()).rejects.toThrow('disk');
    expect(index.cursor()).toBe(0);
    write.mockRestore();
    await uploader.catchUp();
    expect(index.cursor()).toBe(8);
  });
});
