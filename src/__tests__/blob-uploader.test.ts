import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';

const {
  mockRequestUrl,
  mockEncode,
  mockDecode,
  mockCreateDocument,
  MockWebSocket,
  mockWsInstance,
  mockSanitizeSvg,
} = vi.hoisted(() => {
  const mockWsInstance = {
    readyState: 1,
    binaryType: '',
    send: vi.fn(),
    close: vi.fn(),
    onopen: null as ((ev: Event) => void) | null,
    onmessage: null as ((ev: MessageEvent) => void) | null,
    onclose: null as ((ev: CloseEvent) => void) | null,
    onerror: null as ((ev: Event) => void) | null,
  };
  const MockWebSocket = vi.fn(function () {
    return mockWsInstance;
  });
  (MockWebSocket as unknown as { OPEN: number }).OPEN = 1;
  return {
    mockRequestUrl: vi.fn(),
    mockEncode: vi.fn().mockImplementation((obj: unknown) =>
      new TextEncoder().encode(JSON.stringify(obj)),
    ),
    mockDecode: vi.fn(),
    mockCreateDocument: vi.fn().mockReturnValue({
      get_text: vi.fn().mockReturnValue(''),
      export_snapshot: vi.fn().mockReturnValue(new Uint8Array(0)),
      import_snapshot: vi.fn(),
      export_vv_json: vi.fn().mockReturnValue('{}'),
    }),
    MockWebSocket,
    mockWsInstance,
    mockSanitizeSvg: vi.fn((bytes: Uint8Array) => bytes),
  };
});
vi.mock('obsidian', async () => {
  const base = await vi.importActual<Record<string, unknown>>('../__mocks__/obsidian');
  return { ...base, requestUrl: mockRequestUrl };
});
vi.mock('@msgpack/msgpack', () => ({
  encode: mockEncode,
  decode: mockDecode,
}));
vi.mock('../wasm-bridge', () => ({
  createDocument: mockCreateDocument,
}));
vi.mock('../../wasm/vaultcrdt_wasm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../wasm/vaultcrdt_wasm')>();
  return { ...actual, sanitize_svg: mockSanitizeSvg };
});
vi.stubGlobal('WebSocket', MockWebSocket);

import initWasmModule, { blake3_hex, blob_path_key } from '../../wasm/vaultcrdt_wasm';
import { BlobIndex } from '../blob-index';
import { BlobUploader } from '../blob-uploader';
import { isAttachmentPath } from '../path-policy';
import { SyncEngine } from '../sync-engine';
import { FEATURE_BLOBS } from '../server-features';
import { remoteDeleteKeptNoticeMessage, remoteDeleteTrashedNoticeMessage } from '../user-facing-copy';

const PATH = 'Bilder/photo.png';
const PATH_B = 'Bilder/other.png';
const PATH_NEW = 'Bilder/renamed.png';
const PATH_CASE = 'Bilder/Photo.png';
const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const MIB = 1024 * 1024;

interface Call { url: string; method: string; headers?: Record<string, string>; body?: unknown }
const calls = (): Call[] => mockRequestUrl.mock.calls.map((c) => c[0] as Call);
const urls = () => calls().map((c) => `${c.method} ${c.url.replace('https://s.example.com', '')}`);
const ranges = () => calls().filter((c) => c.method === 'PUT').map((c) => c.headers?.['Content-Range']);

function memStorage() {
  const files = new Map<string, unknown>();
  return {
    files,
    loadJson: async <T,>(name: string) => (files.get(name) ?? null) as T | null,
    saveJson: async (name: string, value: unknown) => { files.set(name, value); },
  };
}

function makeUploader(opts: {
  blobs?: boolean;
  size?: number;
  files?: Record<string, Uint8Array>;
  isMobile?: boolean;
  hydratePending?: () => Promise<void>;
  trashIfPresent?: (path: string) => Promise<void>;
  removeFile?: (path: string) => Promise<void>;
  obsidianSyncEnabled?: () => { settings: boolean; styles: boolean };
  readBinary?: ((path: string) => Promise<ArrayBuffer>) & { mock?: unknown };
  writeBinary?: (path: string, data: ArrayBuffer) => Promise<void>;
  now?: () => number;
} = {}) {
  const index = new BlobIndex(memStorage());
  const notify = vi.fn();
  const readBinary: (path: string) => Promise<ArrayBuffer> =
    opts.readBinary ?? (async (path: string) => {
      const f = opts.files?.[path];
      if (f) return f.slice().buffer;
      return BYTES.slice().buffer;
    });
  const writeBinary = opts.writeBinary ?? vi.fn(async () => undefined);
  const uploader = new BlobUploader({
    index,
    serverUrl: () => 'https://s.example.com',
    peerId: () => 'peer-1',
    getJwt: async () => 'jwt-1',
    blobsEnabled: async () => opts.blobs !== false,
    stat: async (path: string) => {
      if (opts.files) {
        const f = opts.files[path];
        return f ? { size: f.byteLength } : null;
      }
      return { size: opts.size ?? BYTES.length };
    },
    readBinary,
    writeBinary,
    notify,
    isMobile: opts.isMobile ?? false,
    sleep: async () => undefined,
    now: opts.now ?? (() => 0),
    hydratePending: opts.hydratePending,
    trashIfPresent: opts.trashIfPresent,
    removeFile: opts.removeFile,
    obsidianSyncEnabled: opts.obsidianSyncEnabled,
  });
  return { uploader, index, notify, readBinary, writeBinary };
}

const resp = (status: number, json: Record<string, unknown> = {}) => ({ status, json });

function makeEngineApp() {
  const adapter = {
    exists: vi.fn().mockResolvedValue(false),
    read: vi.fn().mockResolvedValue(''),
    readBinary: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
    write: vi.fn().mockResolvedValue(undefined),
    writeBinary: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ files: [], folders: [] }),
  };
  return {
    vault: {
      adapter,
      getMarkdownFiles: vi.fn().mockReturnValue([]),
      read: vi.fn().mockResolvedValue(''),
      getAbstractFileByPath: vi.fn().mockReturnValue(null),
      on: vi.fn(),
    },
    fileManager: { trashFile: vi.fn().mockResolvedValue(undefined), renameFile: vi.fn() },
    workspace: {
      on: vi.fn(),
      getActiveViewOfType: vi.fn(() => null),
      iterateAllLeaves: vi.fn(),
    },
  } as any;
}

function makeEngineSettings() {
  return {
    serverUrl: 'http://localhost:3737',
    vaultSecret: 'test-api-key',
    peerId: 'peer-test',
    vaultId: 'vault-abc',
    deviceName: 'test-device',
    showSyncStatus: true,
    onboardingComplete: false,
  } as any;
}

const flush = async (n = 20) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

beforeAll(async () => {
  const bytes = readFileSync(new URL('../../wasm/vaultcrdt_wasm_bg.wasm', import.meta.url));
  await initWasmModule({ module_or_path: bytes });
});
beforeEach(() => {
  mockRequestUrl.mockReset();
  mockSanitizeSvg.mockReset();
  mockSanitizeSvg.mockImplementation((bytes: Uint8Array) => bytes);
  mockEncode.mockClear();
  mockDecode.mockReset();
  MockWebSocket.mockClear();
  mockWsInstance.readyState = 1;
  mockWsInstance.onopen = null;
  mockWsInstance.onmessage = null;
  mockWsInstance.onclose = null;
  mockWsInstance.onerror = null;
  mockWsInstance.send.mockClear();
});

describe('BlobUploader (attachment lane S2)', () => {
  it('uploads before it references, and never references a failed transfer', async () => {
    const { uploader, index } = makeUploader();
    mockRequestUrl
      .mockResolvedValueOnce(resp(201, { upload_id: 'u1', next_offset: 0, segment_bytes: 4 }))
      .mockResolvedValueOnce(resp(202, { next_offset: 4 }))
      .mockResolvedValueOnce(resp(202, { next_offset: 8 }))
      .mockResolvedValueOnce(resp(201, { hash: blake3_hex(BYTES) }))
      .mockResolvedValueOnce(resp(200, { accepted: true, seq: 7 }));

    uploader.onFileChanged(PATH);
    await uploader.flush();

    expect(urls()).toEqual([
      'POST /vault/blobs/uploads',
      'PUT /vault/blobs/uploads/u1',
      'PUT /vault/blobs/uploads/u1',
      'PUT /vault/blobs/uploads/u1',
      'POST /vault/blob-paths',
    ]);
    expect(ranges()).toEqual(['bytes 0-3/10', 'bytes 4-7/10', 'bytes 8-9/10']);
    const entry = index.get(PATH)!;
    expect(entry.lastRemoteHash).toBe(blake3_hex(BYTES));
    expect(entry.seq).toBe(7);
    expect(entry.generation).toBe(1);
    expect(index.maxSeq()).toBe(7);
  });

  it('never calls blob-paths when a segment keeps failing', async () => {
    const { uploader, index } = makeUploader();
    mockRequestUrl
      .mockResolvedValueOnce(resp(201, { upload_id: 'u1', next_offset: 0, segment_bytes: 4 }))
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(resp(200, { next_offset: 4 })) // resume probe
      .mockRejectedValueOnce(new Error('network again'));

    uploader.onFileChanged(PATH);
    await uploader.flush();

    expect(urls()).toEqual([
      'POST /vault/blobs/uploads',
      'PUT /vault/blobs/uploads/u1',
      'GET /vault/blobs/uploads/u1',
      'PUT /vault/blobs/uploads/u1',
    ]);
    expect(index.get(PATH)).toBeUndefined();
  });

  it('short-circuits on dedup: no PUT, one blob-paths', async () => {
    const { uploader } = makeUploader();
    mockRequestUrl
      .mockResolvedValueOnce(resp(200, { exists: true }))
      .mockResolvedValueOnce(resp(200, { accepted: true, seq: 3 }));

    uploader.onFileChanged(PATH);
    await uploader.flush();

    expect(urls()).toEqual(['POST /vault/blobs/uploads', 'POST /vault/blob-paths']);
  });

  it('suppresses echo when lastRemoteHash matches the recomputed hash', async () => {
    const { uploader, index } = makeUploader();
    index.update(PATH, { hash: blake3_hex(BYTES), lastRemoteHash: blake3_hex(BYTES) });

    uploader.onFileChanged(PATH);
    await uploader.flush();

    expect(mockRequestUrl).not.toHaveBeenCalled();
  });

  it('skips oversized files before reading, and notices only once per path', async () => {
    const readBinary = vi.fn(async (_path: string) => new ArrayBuffer(0));
    const { uploader, index, notify } = makeUploader({ size: 11 * 1024 * 1024, readBinary });

    uploader.onFileChanged(PATH);
    await uploader.flush();
    uploader.onFileChanged(PATH);
    await uploader.flush();

    expect(readBinary).not.toHaveBeenCalled();
    expect(mockRequestUrl).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(index.get(PATH)!.skipped).toBe(true);
  });

  it('resumes at the offset a 409 reports', async () => {
    const { uploader } = makeUploader();
    mockRequestUrl
      .mockResolvedValueOnce(resp(201, { upload_id: 'u1', next_offset: 0, segment_bytes: 4 }))
      .mockResolvedValueOnce(resp(409, { next_offset: 8 }))
      .mockResolvedValueOnce(resp(201, { hash: blake3_hex(BYTES) }))
      .mockResolvedValueOnce(resp(200, { accepted: true, seq: 1 }));

    uploader.onFileChanged(PATH);
    await uploader.flush();

    expect(ranges()).toEqual(['bytes 0-3/10', 'bytes 8-9/10']);
  });

  it('re-uploads once on 412 and then fails without touching the index', async () => {
    const { uploader, index } = makeUploader();
    const segments = () => [
      resp(201, { upload_id: 'u1', next_offset: 0, segment_bytes: 16 }),
      resp(201, { hash: blake3_hex(BYTES) }),
    ];
    for (const r of segments()) mockRequestUrl.mockResolvedValueOnce(r);
    mockRequestUrl.mockResolvedValueOnce(resp(412, {}));
    for (const r of segments()) mockRequestUrl.mockResolvedValueOnce(r);
    mockRequestUrl.mockResolvedValueOnce(resp(412, {}));

    uploader.onFileChanged(PATH);
    await uploader.flush();

    expect(urls()).toEqual([
      'POST /vault/blobs/uploads', 'PUT /vault/blobs/uploads/u1', 'POST /vault/blob-paths',
      'POST /vault/blobs/uploads', 'PUT /vault/blobs/uploads/u1', 'POST /vault/blob-paths',
    ]);
    expect(index.get(PATH)).toBeUndefined();
  });

  it('catch-up records hydrated:false for changed hashes and advances max_seq', async () => {
    const { uploader, index } = makeUploader();
    const entry = index.update(PATH, { hash: 'aaa', seq: 4, lastRemoteHash: 'aaa' })!;
    mockRequestUrl.mockResolvedValueOnce(resp(200, {
      states: [
        { path_key: entry.key, state: 'live', content_hash: 'bbb', seq: 9 },
        { path_key: 'unknown-key', state: 'live', content_hash: 'ccc', seq: 11 },
      ],
      max_seq: 11,
    }));

    await uploader.catchUp();

    expect(urls()).toEqual(['GET /vault/blob-paths?since_seq=4&limit=1000']);
    expect(index.get(PATH)!.hydrated).toBe(false);
    expect(index.maxSeq()).toBe(11);
  });

  it('is fully dormant without the blobs feature', async () => {
    const { uploader } = makeUploader({ blobs: false });
    uploader.onFileChanged(PATH);
    await uploader.flush();
    await uploader.catchUp();
    expect(mockRequestUrl).not.toHaveBeenCalled();
  });

  it('whitelist: voice.webm and rec.3gp pass; video.mp4 does not', () => {
    expect(isAttachmentPath('voice.webm')).toBe(true);
    expect(isAttachmentPath('rec.3gp')).toBe(true);
    expect(isAttachmentPath('video.mp4')).toBe(false);
  });

  it('skips oversized webm/3gp before reading (audio cap), but 11 MiB webm is under the cap', async () => {
    const readOversized = vi.fn(async () => new ArrayBuffer(0));
    const oversized = makeUploader({ size: 26 * MIB, readBinary: readOversized });
    oversized.uploader.onFileChanged('voice.webm');
    await oversized.uploader.flush();
    expect(readOversized).not.toHaveBeenCalled();
    expect(mockRequestUrl).not.toHaveBeenCalled();
    expect(oversized.index.get('voice.webm')!.skipped).toBe(true);

    const readOk = vi.fn(async () => BYTES.slice().buffer);
    const under = makeUploader({ size: 11 * MIB, readBinary: readOk });
    mockRequestUrl
      .mockResolvedValueOnce(resp(200, { exists: true }))
      .mockResolvedValueOnce(resp(200, { accepted: true, seq: 1 }));
    under.uploader.onFileChanged('rec.3gp');
    await under.uploader.flush();
    expect(readOk).toHaveBeenCalled();
    expect(urls()[0]).toBe('POST /vault/blobs/uploads');
  });

  it('uses the local next generation and never reads resp.json.generation', async () => {
    const { uploader, index } = makeUploader();
    index.update(PATH, { generation: 3, hash: 'old' });
    const json: Record<string, unknown> = { accepted: true, seq: 5 };
    Object.defineProperty(json, 'generation', {
      get() { throw new Error('generation must not be read'); },
    });
    mockRequestUrl
      .mockResolvedValueOnce(resp(200, { exists: true }))
      .mockResolvedValueOnce({ status: 200, json });

    uploader.onFileChanged(PATH);
    await uploader.flush();

    expect(index.get(PATH)!.generation).toBe(4);
    expect(index.get(PATH)!.seq).toBe(5);
  });

  it('putSegment sends slice().buffer of a copy (own buffer, exact segment length)', async () => {
    const { uploader } = makeUploader();
    mockRequestUrl
      .mockResolvedValueOnce(resp(201, { upload_id: 'u1', next_offset: 0, segment_bytes: 4 }))
      .mockResolvedValueOnce(resp(202, { next_offset: 4 }))
      .mockResolvedValueOnce(resp(202, { next_offset: 8 }))
      .mockResolvedValueOnce(resp(201, { hash: blake3_hex(BYTES) }))
      .mockResolvedValueOnce(resp(200, { accepted: true, seq: 1 }));

    uploader.onFileChanged(PATH);
    await uploader.flush();

    const putBodies = calls().filter((c) => c.method === 'PUT').map((c) => c.body);
    expect(putBodies).toHaveLength(3);
    for (const [i, body] of putBodies.entries()) {
      expect(body).toBeInstanceOf(ArrayBuffer);
      const expected = i < 2 ? 4 : 2;
      expect((body as ArrayBuffer).byteLength).toBe(expected);
    }
  });

  it.each([
    [
      'throwing json getter',
      () => ({
        status: 413,
        get json(): Record<string, unknown> { throw new Error('axum guard'); },
        text: JSON.stringify({ error: 'quota_exceeded', quota_bytes: 50 * MIB }),
      }),
    ],
    [
      'undefined json',
      () => ({
        status: 413,
        json: undefined,
        text: JSON.stringify({ error: 'quota_exceeded', quota_bytes: 50 * MIB }),
      }),
    ],
  ])('quota 413 notices once vault-wide and skips other POSTs until the TTL (%s)', async (_label, makeQuota) => {
    let now = 0;
    const { uploader, notify, index } = makeUploader({ now: () => now });
    mockRequestUrl.mockResolvedValueOnce(makeQuota());

    uploader.onFileChanged(PATH);
    await uploader.flush();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain('50 MB');
    expect(uploader.quotaExceededUntil).toBe(60_000);
    expect(index.get(PATH)!.skipped).toBe(true);

    mockRequestUrl.mockClear();
    uploader.onFileChanged(PATH_B);
    await uploader.flush();
    expect(mockRequestUrl).not.toHaveBeenCalled();
    expect(index.get(PATH_B)!.skipped).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);

    now = 60_000;
    mockRequestUrl.mockResolvedValueOnce(makeQuota());
    uploader.onFileChanged(PATH_B);
    await uploader.flush();
    expect(calls().some((c) => c.method === 'POST' && c.url.includes('/vault/blobs/uploads'))).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(uploader.quotaExceededUntil).toBe(120_000);
  });

  it('quota 413 without quota_bytes still pauses and does not throw', async () => {
    const { uploader, notify, index } = makeUploader();
    mockRequestUrl.mockResolvedValueOnce(resp(413, {}));

    uploader.onFileChanged(PATH);
    await uploader.flush();

    expect(uploader.quotaExceededUntil).toBe(60_000);
    expect(index.get(PATH)!.skipped).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(mockRequestUrl).toHaveBeenCalledTimes(1);

    mockRequestUrl.mockClear();
    uploader.onFileChanged(PATH_B);
    await uploader.flush();
    expect(mockRequestUrl).not.toHaveBeenCalled();
  });

  it('quota 413 on blob-paths pauses without throwing (dedup path)', async () => {
    const { uploader, notify, index } = makeUploader();
    mockRequestUrl
      .mockResolvedValueOnce(resp(200, { exists: true }))
      .mockResolvedValueOnce(resp(413, { error: 'quota_exceeded', quota_bytes: 50 * MIB }));

    uploader.onFileChanged(PATH);
    await uploader.flush();

    expect(urls()).toEqual(['POST /vault/blobs/uploads', 'POST /vault/blob-paths']);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain('50 MB');
    expect(uploader.quotaExceededUntil).toBe(60_000);
    expect(index.get(PATH)!.skipped).toBe(true);

    mockRequestUrl.mockClear();
    uploader.onFileChanged(PATH_B);
    await uploader.flush();
    expect(mockRequestUrl).not.toHaveBeenCalled();
  });

  it('does not POST blob-paths while quotaExceededUntil is already in the future', async () => {
    const { uploader, index } = makeUploader();
    mockRequestUrl.mockImplementation(async (opts: Call) => {
      if (opts.method === 'POST' && opts.url.includes('/vault/blobs/uploads')) {
        uploader.quotaExceededUntil = 60_000;
        return resp(200, { exists: true });
      }
      return resp(200, { accepted: true, seq: 1 });
    });

    uploader.onFileChanged(PATH);
    await uploader.flush();

    expect(urls()).toEqual(['POST /vault/blobs/uploads']);
    expect(index.get(PATH)!.skipped).toBe(true);
  });

  it('0. catchUp creates index entries for unknown live states (second device)', async () => {
    const hash = blake3_hex(BYTES);
    const key = blob_path_key(PATH)!;
    const live = {
      path_key: key,
      display_path: PATH,
      state: 'live',
      content_hash: hash,
      size: BYTES.length,
      generation: 4,
      seq: 12,
    };

    const absent = makeUploader({ files: {} });
    mockRequestUrl.mockResolvedValueOnce(resp(200, { states: [live], max_seq: 12 }));
    await absent.uploader.catchUp();
    expect(absent.index.get(PATH)).toMatchObject({
      key, hash, size: BYTES.length, generation: 4, seq: 12, hydrated: false, lastRemoteHash: null,
    });
    expect(urls()).toEqual(['GET /vault/blob-paths?since_seq=0&limit=1000']);

    mockRequestUrl.mockReset();
    const present = makeUploader({ files: { [PATH]: BYTES } });
    mockRequestUrl.mockResolvedValueOnce(resp(200, { states: [live], max_seq: 12 }));
    await present.uploader.catchUp();
    expect(present.index.get(PATH)).toMatchObject({
      hash, hydrated: true, lastRemoteHash: hash, generation: 4, seq: 12,
    });
    expect(urls()).toEqual(['GET /vault/blob-paths?since_seq=0&limit=1000']);
  });

  it('does not index or hydrate an unindexed local file that differs from remote live state', async () => {
    const local = new Uint8Array([1, 1, 1, 1, 1]);
    const remote = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 9, 9]);
    const files: Record<string, Uint8Array> = { [PATH]: local };
    const box: { index: BlobIndex | null } = { index: null };
    const { uploader, index } = makeUploader({
      files,
      hydratePending: async () => {
        if (box.index?.get(PATH)) {
          throw new Error('must not hydrate unindexed local diverge');
        }
      },
    });
    box.index = index;
    mockRequestUrl.mockImplementation(async (opts: Call) => {
      if (opts.method === 'GET' && opts.url.includes('/vault/blob-paths')) {
        return resp(200, {
          states: [{
            path_key: blob_path_key(PATH),
            display_path: PATH,
            state: 'live',
            content_hash: blake3_hex(remote),
            size: remote.length,
            generation: 2,
            seq: 15,
          }],
          max_seq: 15,
        });
      }
      throw new Error(`unexpected ${opts.method} ${opts.url}`);
    });

    await uploader.catchUp();

    expect(index.get(PATH)).toBeUndefined();
    expect(files[PATH]).toEqual(local);
    expect(calls().filter((c) => c.url.includes('/vault/blobs/'))).toEqual([]);
  });

  it('5. rename different key: live POST + old tombstone, no re-upload, index moved', async () => {
    const { uploader, index } = makeUploader();
    const hash = blake3_hex(BYTES);
    const oldKey = blob_path_key(PATH)!;
    const newKey = blob_path_key(PATH_NEW)!;
    expect(oldKey).not.toBe(newKey);
    index.update(PATH, {
      hash, size: BYTES.length, generation: 2, seq: 5, lastRemoteHash: hash, hydrated: true,
    });
    mockRequestUrl
      .mockResolvedValueOnce(resp(200, { accepted: true, seq: 8 }))
      .mockResolvedValueOnce(resp(200, { accepted: true, seq: 9 }));

    await uploader.onFileRenamed(PATH, PATH_NEW);

    const posts = calls().filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.url.replace('https://s.example.com', ''))).toEqual([
      '/vault/blob-paths', '/vault/blob-paths',
    ]);
    expect(calls().filter((c) => c.method === 'PUT')).toEqual([]);
    const bodies = posts.map((c) => JSON.parse(c.body as string));
    expect(bodies[0]).toMatchObject({
      path_key: newKey, display_path: PATH_NEW, state: 'live', content_hash: hash, generation: 3,
    });
    expect(bodies[1]).toMatchObject({
      path_key: oldKey, display_path: PATH, state: 'deleted', content_hash: hash, generation: 3,
    });
    expect(index.get(PATH)).toBeUndefined();
    expect(index.get(PATH_NEW)).toMatchObject({ key: newKey, hash, generation: 3, seq: 8 });
    expect(index.pathForKey(newKey)).toBe(PATH_NEW);
  });

  it('6. rename case-only: ONE POST, same key, display updated, gen+1', async () => {
    const { uploader, index } = makeUploader();
    const hash = blake3_hex(BYTES);
    const key = blob_path_key(PATH)!;
    expect(blob_path_key(PATH_CASE)).toBe(key);
    index.update(PATH, {
      hash, size: BYTES.length, generation: 2, seq: 5, lastRemoteHash: hash, hydrated: true,
    });
    mockRequestUrl.mockResolvedValueOnce(resp(200, { accepted: true, seq: 6 }));

    await uploader.onFileRenamed(PATH, PATH_CASE);

    expect(urls()).toEqual(['POST /vault/blob-paths']);
    expect(JSON.parse(calls()[0].body as string)).toMatchObject({
      path_key: key, display_path: PATH_CASE, state: 'live', content_hash: hash, generation: 3,
    });
    expect(index.get(PATH)).toBeUndefined();
    expect(index.get(PATH_CASE)).toMatchObject({ key, hash, generation: 3, seq: 6 });
    expect(index.pathForKey(key)).toBe(PATH_CASE);
  });

  it('7. remote tombstone: unmodified trashes; locally modified is kept and republished', async () => {
    const hash = blake3_hex(BYTES);
    const key = blob_path_key(PATH)!;
    const tomb = {
      path_key: key,
      display_path: PATH,
      state: 'deleted',
      content_hash: hash,
      generation: 3,
      seq: 20,
    };

    const trash = vi.fn(async () => undefined);
    const unmodified = makeUploader({ files: { [PATH]: BYTES }, trashIfPresent: trash });
    unmodified.index.update(PATH, {
      hash, size: BYTES.length, generation: 2, seq: 5, lastRemoteHash: hash, hydrated: true,
    });
    mockRequestUrl.mockResolvedValueOnce(resp(200, { states: [tomb], max_seq: 20 }));
    await unmodified.uploader.catchUp();
    expect(trash).toHaveBeenCalledExactlyOnceWith(PATH);
    expect(unmodified.index.get(PATH)).toBeUndefined();
    expect(unmodified.notify).toHaveBeenCalledWith(remoteDeleteTrashedNoticeMessage(PATH));
    expect(urls()).toEqual(['GET /vault/blob-paths?since_seq=5&limit=1000']);

    mockRequestUrl.mockReset();
    const trash2 = vi.fn(async () => undefined);
    const modified = makeUploader({ files: { [PATH]: BYTES }, trashIfPresent: trash2 });
    modified.index.update(PATH, {
      hash, size: BYTES.length, generation: 2, seq: 5, lastRemoteHash: 'old-remote', hydrated: true,
    });
    mockRequestUrl
      .mockResolvedValueOnce(resp(200, { states: [tomb], max_seq: 20 }))
      .mockResolvedValueOnce(resp(200, { exists: true }))
      .mockResolvedValueOnce(resp(200, { accepted: true, seq: 21 }));
    await modified.uploader.catchUp();
    expect(trash2).not.toHaveBeenCalled();
    expect(modified.index.get(PATH)).toMatchObject({
      hash, hydrated: true, lastRemoteHash: hash, generation: 4,
    });
    expect(modified.notify).toHaveBeenCalledWith(remoteDeleteKeptNoticeMessage(PATH));
    expect(urls()).toEqual([
      'GET /vault/blob-paths?since_seq=5&limit=1000',
      'POST /vault/blobs/uploads',
      'POST /vault/blob-paths',
    ]);
    expect(JSON.parse(calls()[2].body as string)).toMatchObject({
      path_key: key, state: 'live', content_hash: hash, generation: 4,
    });
  });

  const SVG_PATH = 'Bilder/icon.svg';
  const SVG_BYTES = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  );
  const FIXED = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
  );

  it('parks when sanitize_svg throws, without POSTing', async () => {
    mockSanitizeSvg.mockImplementation(() => { throw new Error('svg: malformed XML'); });
    const { uploader, index, notify } = makeUploader({ files: { [SVG_PATH]: SVG_BYTES } });
    uploader.onFileChanged(SVG_PATH);
    await uploader.flush();
    expect(index.get(SVG_PATH)!.skipped).toBe(true);
    expect(mockRequestUrl).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('uploads sanitized bytes: POST hash and PUT body match fixedBytes', async () => {
    mockSanitizeSvg.mockReturnValue(FIXED);
    const { uploader } = makeUploader({ files: { [SVG_PATH]: SVG_BYTES } });
    mockRequestUrl
      .mockResolvedValueOnce(resp(201, { upload_id: 'u1', next_offset: 0, segment_bytes: 1024 }))
      .mockResolvedValueOnce(resp(201, { hash: blake3_hex(FIXED) }))
      .mockResolvedValueOnce(resp(200, { accepted: true, seq: 1 }));
    uploader.onFileChanged(SVG_PATH);
    await uploader.flush();
    const start = calls().find((c) => c.method === 'POST' && c.url.includes('/vault/blobs/uploads'));
    expect(JSON.parse(start!.body as string).hash).toBe(blake3_hex(FIXED));
    const put = calls().find((c) => c.method === 'PUT');
    expect(new Uint8Array(put!.body as ArrayBuffer)).toEqual(FIXED);
  });

  it('writes sanitized bytes back and uses sanitized size, not stat size', async () => {
    mockSanitizeSvg.mockReturnValue(FIXED);
    const writeBinary = vi.fn(async (_path: string, _data: ArrayBuffer) => undefined);
    const { uploader } = makeUploader({ files: { [SVG_PATH]: SVG_BYTES }, writeBinary });
    mockRequestUrl
      .mockResolvedValueOnce(resp(200, { exists: true }))
      .mockResolvedValueOnce(resp(200, { accepted: true, seq: 1 }));
    uploader.onFileChanged(SVG_PATH);
    await uploader.flush();
    expect(writeBinary).toHaveBeenCalledTimes(1);
    expect(writeBinary.mock.calls[0][0]).toBe(SVG_PATH);
    expect(new Uint8Array(writeBinary.mock.calls[0][1])).toEqual(FIXED);
    const start = calls().find((c) => c.method === 'POST' && c.url.includes('/vault/blobs/uploads'));
    expect(JSON.parse(start!.body as string).size).toBe(FIXED.byteLength);
    expect(JSON.parse(start!.body as string).size).not.toBe(SVG_BYTES.byteLength);
  });

  it('parks with notice on attach 422 and does not throw', async () => {
    const { uploader, index, notify } = makeUploader({ files: { [SVG_PATH]: SVG_BYTES } });
    mockRequestUrl
      .mockResolvedValueOnce(resp(200, { exists: true }))
      .mockResolvedValueOnce(resp(422, { error: 'sanitize mismatch' }));
    uploader.onFileChanged(SVG_PATH);
    await uploader.flush();
    expect(index.get(SVG_PATH)!.skipped).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain('sanitize mismatch');
  });

  it('parks with notice on upload finalize 422 and does not throw', async () => {
    const { uploader, index, notify } = makeUploader({ files: { [SVG_PATH]: SVG_BYTES } });
    mockRequestUrl.mockResolvedValueOnce(resp(422, { error: 'bytes rejected' }));
    uploader.onFileChanged(SVG_PATH);
    await expect(uploader.flush()).resolves.toBeUndefined();
    expect(index.get(SVG_PATH)!.skipped).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain('bytes rejected');
    expect(urls()).toEqual(['POST /vault/blobs/uploads']);
  });

  it('republishLive uploads sanitized svg bytes, not raw disk bytes', async () => {
    mockSanitizeSvg.mockReturnValue(FIXED);
    const writeBinary = vi.fn(async (_path: string, _data: ArrayBuffer) => undefined);
    const key = blob_path_key(SVG_PATH)!;
    const tomb = {
      path_key: key,
      display_path: SVG_PATH,
      state: 'deleted',
      content_hash: blake3_hex(SVG_BYTES),
      generation: 3,
      seq: 20,
    };
    const { uploader, index } = makeUploader({
      files: { [SVG_PATH]: SVG_BYTES },
      writeBinary,
      trashIfPresent: vi.fn(async () => undefined),
    });
    index.update(SVG_PATH, {
      hash: blake3_hex(SVG_BYTES),
      size: SVG_BYTES.length,
      generation: 2,
      seq: 5,
      lastRemoteHash: 'old-remote',
      hydrated: true,
    });
    mockRequestUrl
      .mockResolvedValueOnce(resp(200, { states: [tomb], max_seq: 20 }))
      .mockResolvedValueOnce(resp(201, { upload_id: 'u1', next_offset: 0, segment_bytes: 1024 }))
      .mockResolvedValueOnce(resp(201, { hash: blake3_hex(FIXED) }))
      .mockResolvedValueOnce(resp(200, { accepted: true, seq: 21 }));
    await uploader.catchUp();
    const start = calls().find((c) => c.method === 'POST' && c.url.includes('/vault/blobs/uploads'));
    expect(JSON.parse(start!.body as string).hash).toBe(blake3_hex(FIXED));
    expect(JSON.parse(start!.body as string).size).toBe(FIXED.byteLength);
    const put = calls().find((c) => c.method === 'PUT');
    expect(new Uint8Array(put!.body as ArrayBuffer)).toEqual(FIXED);
    expect(writeBinary).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(writeBinary.mock.calls[0][1])).toEqual(FIXED);
  });
});

const CFG = '.obsidian/app.json';
const PLUGINS = '.obsidian/plugins/vaultcrdt/data.json';

describe('.obsidian blob-path catch-up', () => {
  it('toggle-off indexes incoming category states as skipped, never hydrates',
    async () => {
      const hash = blake3_hex(BYTES);
      const hydratePending = vi.fn(async () => undefined);
      const { uploader, index } = makeUploader({
        files: {},
        hydratePending,
        obsidianSyncEnabled: () => ({ settings: false, styles: false }),
      });
      mockRequestUrl.mockResolvedValueOnce(resp(200, {
        states: [{
          path_key: blob_path_key(CFG),
          display_path: CFG,
          state: 'live',
          content_hash: hash,
          size: BYTES.length,
          generation: 1,
          seq: 8,
        }],
        max_seq: 8,
      }));
      await uploader.catchUp();
      expect(index.get(CFG)).toMatchObject({
        skipped: true, hydrated: false, hash, seq: 8,
      });
      expect(index.get(CFG)!.hydrated).toBe(false);
    });

  it('toggle-on catch-up indexes a category file as pending hydration',
    async () => {
      const hash = blake3_hex(BYTES);
      const { uploader, index } = makeUploader({
        files: {},
        obsidianSyncEnabled: () => ({ settings: true, styles: false }),
      });
      mockRequestUrl.mockResolvedValueOnce(resp(200, {
        states: [{
          path_key: blob_path_key(CFG),
          display_path: CFG,
          state: 'live',
          content_hash: hash,
          size: BYTES.length,
          generation: 1,
          seq: 8,
        }],
        max_seq: 8,
      }));
      await uploader.catchUp();
      expect(index.get(CFG)).toMatchObject({
        hash, hydrated: false, seq: 8,
      });
      expect(index.get(CFG)!.skipped).toBeFalsy();
    });

  it('display_path into .obsidian/plugins/** never materializes', async () => {
    const { uploader, index } = makeUploader({
      obsidianSyncEnabled: () => ({ settings: true, styles: true }),
    });
    mockRequestUrl.mockResolvedValueOnce(resp(200, {
      states: [{
        path_key: PLUGINS,
        display_path: PLUGINS,
        state: 'live',
        content_hash: blake3_hex(BYTES),
        size: BYTES.length,
        generation: 1,
        seq: 3,
      }],
      max_seq: 3,
    }));
    await uploader.catchUp();
    expect(index.get(PLUGINS)).toBeUndefined();
    expect(index.pathForKey(PLUGINS)).toBeUndefined();
  });

  it('remote tombstone of a category file uses adapter.remove, not trash',
    async () => {
      const hash = blake3_hex(BYTES);
      const key = blob_path_key(CFG)!;
      const trash = vi.fn(async () => undefined);
      const removeFile = vi.fn(async () => undefined);
      const { uploader, index } = makeUploader({
        files: { [CFG]: BYTES },
        trashIfPresent: trash,
        removeFile,
        obsidianSyncEnabled: () => ({ settings: true, styles: false }),
      });
      index.update(CFG, {
        hash, size: BYTES.length, generation: 2, seq: 5,
        lastRemoteHash: hash, hydrated: true,
      });
      mockRequestUrl.mockResolvedValueOnce(resp(200, {
        states: [{
          path_key: key, display_path: CFG, state: 'deleted',
          content_hash: hash, generation: 3, seq: 20,
        }],
        max_seq: 20,
      }));
      await uploader.catchUp();
      expect(removeFile).toHaveBeenCalledExactlyOnceWith(CFG);
      expect(trash).not.toHaveBeenCalled();
      expect(index.get(CFG)).toBeUndefined();
    });

  it('toggle-off skipped category + remote tombstone: index.remove only',
    async () => {
      const hash = blake3_hex(BYTES);
      const key = blob_path_key(CFG)!;
      const trash = vi.fn(async () => undefined);
      const removeFile = vi.fn(async () => undefined);
      const { uploader, index } = makeUploader({
        files: { [CFG]: BYTES },
        trashIfPresent: trash,
        removeFile,
        obsidianSyncEnabled: () => ({ settings: false, styles: false }),
      });
      index.update(CFG, {
        hash, size: BYTES.length, generation: 2, seq: 5,
        lastRemoteHash: 'old', hydrated: false, skipped: true,
      });
      mockRequestUrl.mockResolvedValueOnce(resp(200, {
        states: [{
          path_key: key, display_path: CFG, state: 'deleted',
          content_hash: hash, generation: 3, seq: 20,
        }],
        max_seq: 20,
      }));
      await uploader.catchUp();
      expect(index.get(CFG)).toBeUndefined();
      expect(trash).not.toHaveBeenCalled();
      expect(removeFile).not.toHaveBeenCalled();
      expect(calls().filter((c) => c.method === 'POST')).toEqual([]);
    });
});

describe('SyncEngine blob auth frame and wake-up', () => {
  let engine: SyncEngine;

  beforeEach(() => {
    mockRequestUrl.mockResolvedValue({ json: { token: 'test-token' } });
    engine = new SyncEngine(makeEngineApp(), makeEngineSettings());
  });

  afterEach(async () => {
    await engine.stop();
    vi.useRealTimers();
  });

  it('sends features:[blobs] on start and reconnect iff health advertised it', async () => {
    const getServerFeatures = vi.fn(async () => [FEATURE_BLOBS]);
    engine.getServerFeatures = getServerFeatures;

    await engine.start();
    expect(getServerFeatures).toHaveBeenCalled();
    expect(MockWebSocket).toHaveBeenCalled();
    mockEncode.mockClear();
    mockWsInstance.onopen!({} as Event);
    expect(mockEncode.mock.calls[0][0]).toEqual({
      type: 'auth',
      token: 'test-token',
      protocol_version: 1,
      features: ['blobs'],
    });

    vi.useFakeTimers();
    mockWsInstance.onclose!({} as CloseEvent);
    await flush();
    vi.advanceTimersByTime(1_000);
    await flush();
    mockEncode.mockClear();
    mockWsInstance.onopen!({} as Event);
    expect(mockEncode.mock.calls[0][0]).toEqual({
      type: 'auth',
      token: 'test-token',
      protocol_version: 1,
      features: ['blobs'],
    });
  });

  it('omits features on the auth frame when health did not advertise blobs', async () => {
    engine.getServerFeatures = async () => ['invite'];
    await engine.start();
    mockEncode.mockClear();
    mockWsInstance.onopen!({} as Event);
    expect(mockEncode.mock.calls[0][0]).toEqual({
      type: 'auth',
      token: 'test-token',
      protocol_version: 1,
    });
  });

  it('resolves getServerFeatures before constructing the WebSocket', async () => {
    let resolveFeatures!: (v: string[]) => void;
    engine.getServerFeatures = () => new Promise((r) => { resolveFeatures = r; });
    const started = engine.start();
    await flush();
    expect(MockWebSocket).not.toHaveBeenCalled();
    resolveFeatures([FEATURE_BLOBS]);
    await started;
    expect(MockWebSocket).toHaveBeenCalled();
  });

  it('debounces three blob_path_changed into one catchUp and clears the timer on stop', async () => {
    const catchUp = vi.fn(async () => undefined);
    engine.blobUploader = { catchUp } as any;
    await engine.start();
    vi.useFakeTimers();

    const fire = (seq: number) => {
      mockDecode.mockReturnValueOnce({ type: 'blob_path_changed', path_key: 'notes/voice.webm', seq });
      mockWsInstance.onmessage!({ data: new ArrayBuffer(4) } as MessageEvent);
    };
    fire(1);
    fire(2);
    fire(3);
    expect(catchUp).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(catchUp).toHaveBeenCalledTimes(1);

    fire(4);
    expect((engine as any).blobCatchUpTimer).not.toBeNull();
    await engine.stop();
    expect((engine as any).blobCatchUpTimer).toBeNull();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(catchUp).toHaveBeenCalledTimes(1);
  });
});
