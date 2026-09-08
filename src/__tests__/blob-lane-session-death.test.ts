import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';

const { mockRequestUrl } = vi.hoisted(() => ({ mockRequestUrl: vi.fn() }));
vi.mock('obsidian', async () => {
  const base = await vi.importActual<Record<string, unknown>>('../__mocks__/obsidian');
  return { ...base, requestUrl: mockRequestUrl };
});

import initWasmModule from '../../wasm/vaultcrdt_wasm';
import { BlobIndex } from '../blob-index';
import { BlobUploader } from '../blob-uploader';
import {
  ServerFeatureCache,
  FEATURES_PROBE_TIMEOUT_MS,
  FEATURE_BLOBS,
} from '../server-features';

const PATH = 'Bilder/photo.png';
const BYTES = new Uint8Array([1, 2, 3, 4, 5]);

function memStorage() {
  const files = new Map<string, unknown>();
  return {
    files,
    loadJson: async <T,>(name: string) => (files.get(name) ?? null) as T | null,
    saveJson: async (name: string, value: unknown) => { files.set(name, value); },
  };
}

function makeUploader(gate: { open: boolean }) {
  const index = new BlobIndex(memStorage());
  const uploader = new BlobUploader({
    index,
    serverUrl: () => 'https://s.example.com',
    peerId: () => 'peer-1',
    getJwt: async () => 'jwt-1',
    blobsEnabled: async () => gate.open,
    stat: async () => ({ size: BYTES.length }),
    readBinary: async () => BYTES.slice().buffer,
    writeBinary: async () => undefined,
    notify: vi.fn(),
    isMobile: false,
    sleep: async () => undefined,
    now: () => 0,
  });
  return { uploader, index };
}

const resp = (status: number, json: Record<string, unknown> = {}) => ({ status, json });

beforeAll(async () => {
  const bytes = readFileSync(new URL('../../wasm/vaultcrdt_wasm_bg.wasm', import.meta.url));
  await initWasmModule({ module_or_path: bytes });
});

beforeEach(() => {
  mockRequestUrl.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ServerFeatureCache probe bound (Gap 1)', () => {
  it('resolves within the timeout bound and returns [] on a cold cache', async () => {
    vi.useFakeTimers();
    mockRequestUrl.mockImplementation(() => new Promise(() => { /* never resolves */ }));
    const cache = new ServerFeatureCache();
    const p = cache.get('https://s.example.com');
    await vi.advanceTimersByTimeAsync(FEATURES_PROBE_TIMEOUT_MS + 1);
    await expect(p).resolves.toEqual([]);
    expect(cache.lastErrorAt()).not.toBeNull();
  });

  it('serves the stale last-good list for the same key and does not cache the failure', async () => {
    vi.useFakeTimers();
    mockRequestUrl.mockResolvedValueOnce({ json: { features: [FEATURE_BLOBS], protocol_version: 3 } });
    const cache = new ServerFeatureCache(() => Date.now());
    expect(await cache.get('https://s.example.com')).toEqual([FEATURE_BLOBS]);
    expect(cache.lastErrorAt()).toBeNull();

    // TTL expires, then the probe hangs.
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);
    mockRequestUrl.mockImplementationOnce(() => new Promise(() => { /* hang */ }));
    const p = cache.get('https://s.example.com');
    await vi.advanceTimersByTimeAsync(FEATURES_PROBE_TIMEOUT_MS + 1);
    expect(await p).toEqual([FEATURE_BLOBS]);
    expect(cache.lastErrorAt()).not.toBeNull();

    // Failure was not cached: the next call re-probes.
    mockRequestUrl.mockResolvedValueOnce({ json: { features: [FEATURE_BLOBS, 'invite'] } });
    expect(await cache.get('https://s.example.com')).toEqual([FEATURE_BLOBS, 'invite']);
    expect(mockRequestUrl).toHaveBeenCalledTimes(3);
    expect(cache.lastErrorAt()).toBeNull();
  });

  it('keeps the success path unchanged (cached within TTL, protocolVersion, clear)', async () => {
    mockRequestUrl.mockResolvedValue({ json: { features: ['invite'], protocol_version: 2 } });
    const cache = new ServerFeatureCache();
    expect(await cache.get('https://s.example.com')).toEqual(['invite']);
    expect(await cache.get('https://s.example.com')).toEqual(['invite']);
    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
    expect(cache.protocolVersion()).toBe(2);
    cache.clear();
    await cache.get('https://s.example.com');
    expect(mockRequestUrl).toHaveBeenCalledTimes(2);
  });
});

describe('ServerFeatureCache protocol version scoping (#7)', () => {
  it('caches version and features together per server key', async () => {
    mockRequestUrl.mockResolvedValueOnce({ json: { features: [FEATURE_BLOBS], protocol_version: 9 } });
    const cache = new ServerFeatureCache();
    expect(await cache.get('https://a.example.com')).toEqual([FEATURE_BLOBS]);
    expect(cache.protocolVersion()).toBe(9);

    // Different server: a version from the old server must not leak.
    mockRequestUrl.mockResolvedValueOnce({ json: { features: [FEATURE_BLOBS] } });
    expect(await cache.get('https://b.example.com')).toEqual([FEATURE_BLOBS]);
    expect(cache.protocolVersion()).toBeUndefined();
  });

  it('keeps the previous version when a later probe of the same server omits the field', async () => {
    vi.useFakeTimers();
    mockRequestUrl.mockResolvedValueOnce({ json: { features: [FEATURE_BLOBS], protocol_version: 4 } });
    const cache = new ServerFeatureCache();
    await cache.get('https://a.example.com');
    expect(cache.protocolVersion()).toBe(4);

    vi.setSystemTime(Date.now() + 6 * 60 * 1000);
    mockRequestUrl.mockResolvedValueOnce({ json: { features: [FEATURE_BLOBS] } });
    await cache.get('https://a.example.com');
    expect(cache.protocolVersion()).toBe(4);
    vi.useRealTimers();
  });

  it('clear() drops the cached version as well', async () => {
    mockRequestUrl.mockResolvedValue({ json: { features: [FEATURE_BLOBS], protocol_version: 4 } });
    const cache = new ServerFeatureCache();
    await cache.get('https://a.example.com');
    cache.clear();
    expect(cache.protocolVersion()).toBeUndefined();
  });
});

describe('BlobUploader gate-blocked retry (Gap 2)', () => {
  it('records the path instead of dropping it and posts nothing', async () => {
    const gate = { open: false };
    const { uploader } = makeUploader(gate);
    uploader.onFileChanged(PATH);
    await uploader.flush();
    expect(uploader.gateBlockedPaths()).toEqual([PATH]);
    expect(mockRequestUrl).not.toHaveBeenCalled();
  });

  it('does not accumulate duplicates on repeated blocks', async () => {
    const gate = { open: false };
    const { uploader } = makeUploader(gate);
    for (let i = 0; i < 3; i++) {
      uploader.onFileChanged(PATH);
      await uploader.flush();
    }
    expect(uploader.gateBlockedPaths()).toEqual([PATH]);
  });

  it('retryGateBlocked re-uploads once the gate passes, and clears the set', async () => {
    const gate = { open: false };
    const { uploader } = makeUploader(gate);
    uploader.onFileChanged(PATH);
    await uploader.flush();
    expect(mockRequestUrl).not.toHaveBeenCalled();

    mockRequestUrl.mockImplementation(async (o: { url: string }) =>
      o.url.endsWith('/vault/blobs/uploads')
        ? resp(200, { exists: true })
        : resp(200, { accepted: true, seq: 7 }));
    gate.open = true;
    uploader.retryGateBlocked();
    await uploader.flush();

    expect(uploader.gateBlockedPaths()).toEqual([]);
    const posted = mockRequestUrl.mock.calls.map((c) => (c[0] as { url: string }).url);
    expect(posted.some((u) => u.endsWith('/vault/blob-paths'))).toBe(true);
  });

  it('retryGateBlocked is a no-op when nothing was blocked', async () => {
    const gate = { open: true };
    const { uploader } = makeUploader(gate);
    uploader.retryGateBlocked();
    await uploader.flush();
    expect(mockRequestUrl).not.toHaveBeenCalled();
  });

  it('failure→success transition fires the retry exactly once (main.ts seam logic)', async () => {
    // The main.ts wrapper itself needs a full plugin instance; its transition
    // rule (blobs newly present ⇒ retryGateBlocked) is mirrored here.
    const gate = { open: false };
    const { uploader } = makeUploader(gate);
    uploader.onFileChanged(PATH);
    await uploader.flush();

    const retry = vi.spyOn(uploader, 'retryGateBlocked');
    const cache = new ServerFeatureCache();
    let last = false;
    const observed = async (): Promise<string[]> => {
      const features = await cache.get('https://s.example.com');
      const has = features.includes(FEATURE_BLOBS);
      const was = last;
      last = has;
      if (has && !was) uploader.retryGateBlocked();
      return features;
    };

    mockRequestUrl.mockRejectedValueOnce(new Error('boom'));
    expect(await observed()).toEqual([]);
    expect(retry).not.toHaveBeenCalled();

    mockRequestUrl.mockImplementation(async (o: { url: string }) => {
      if (o.url.endsWith('/health')) return { json: { features: [FEATURE_BLOBS] } };
      return o.url.endsWith('/vault/blobs/uploads')
        ? resp(200, { exists: true })
        : resp(200, { accepted: true, seq: 1 });
    });
    gate.open = true;
    expect(await observed()).toEqual([FEATURE_BLOBS]);
    expect(retry).toHaveBeenCalledTimes(1);
    await observed();
    expect(retry).toHaveBeenCalledTimes(1);
    await uploader.flush();
    expect(uploader.gateBlockedPaths()).toEqual([]);
  });
});
