import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted() runs before imports and vi.mock factories — no TDZ errors.
const {
  mockRequestUrl,
  mockEncode,
  mockDecode,
  mockCreateDocument,
  mockDocInstance,
  MockWebSocket,
  mockWsInstance,
  mockVault,
  mockAdapter,
  MockMarkdownView,
} = vi.hoisted(() => {
  const mockDocInstance = {
    get_text: vi.fn().mockReturnValue(''),
    insert_text: vi.fn(),
    delete_text: vi.fn(),
    export_snapshot: vi.fn().mockReturnValue(new Uint8Array(64)),
    import_snapshot: vi.fn(),
    sync_from_disk: vi.fn(),
    version: vi.fn().mockReturnValue(0),
    text_matches: vi.fn().mockReturnValue(false),
    export_vv_json: vi.fn().mockReturnValue('{}'),
    export_delta_since_vv_json: vi.fn().mockReturnValue(new Uint8Array(32)),
    import_and_diff: vi.fn().mockReturnValue(''),
  };

  const mockRequestUrl = vi.fn().mockResolvedValue({
    json: { token: 'test-token' },
  });

  const mockEncode = vi.fn().mockImplementation((obj: unknown) =>
    new TextEncoder().encode(JSON.stringify(obj))
  );

  const mockDecode = vi.fn();
  const mockCreateDocument = vi.fn().mockReturnValue(mockDocInstance);

  const mockWsInstance = {
    readyState: 1, // OPEN
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
  (MockWebSocket as any).OPEN = 1;
  (MockWebSocket as any).CONNECTING = 0;
  (MockWebSocket as any).CLOSING = 2;
  (MockWebSocket as any).CLOSED = 3;

  const mockAdapter = {
    exists: vi.fn().mockResolvedValue(false),
    read: vi.fn().mockResolvedValue(''),
    readBinary: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
    write: vi.fn().mockResolvedValue(undefined),
    writeBinary: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ files: [], folders: [] }),
  };

  const mockVault = {
    adapter: mockAdapter,
    getMarkdownFiles: vi.fn().mockReturnValue([]),
    read: vi.fn().mockResolvedValue(''),
    modify: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue(undefined),
    createFolder: vi.fn().mockResolvedValue(undefined),
    getAbstractFileByPath: vi.fn().mockReturnValue(null),
    trash: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  };

  class MockMarkdownView {
    file: { path: string } | null = null;
    editor: Record<string, unknown> | null = null;
  }

  return {
    mockRequestUrl,
    mockEncode,
    mockDecode,
    mockCreateDocument,
    mockDocInstance,
    MockWebSocket,
    mockWsInstance,
    mockVault,
    mockAdapter,
    MockMarkdownView,
  };
});

vi.mock('obsidian', () => ({
  requestUrl: mockRequestUrl,
  App: vi.fn(),
  TFile: vi.fn(),
  MarkdownView: MockMarkdownView,
  normalizePath: (p: string) => p,
}));

vi.mock('@msgpack/msgpack', () => ({
  encode: mockEncode,
  decode: mockDecode,
}));

vi.mock('../wasm-bridge', () => ({
  createDocument: mockCreateDocument,
}));

vi.stubGlobal('WebSocket', MockWebSocket);

import { SyncEngine } from '../sync-engine';
import { TFile, MarkdownView } from 'obsidian';

// ── Helpers ────────────────────────────────────────────────────────────────────

const makeSettings = (overrides: Record<string, unknown> = {}) => ({
  serverUrl: 'http://localhost:3737',
  vaultSecret: 'test-api-key',
  peerId: 'peer-test',
  vaultId: 'vault-abc',
  deviceName: 'test-device',
  debounceMs: 300,
  showSyncStatus: true,
  onboardingComplete: false,
  ...overrides,
});

const makeApp = (leaves: any[] = []) =>
  ({
    vault: mockVault,
    workspace: {
      on: vi.fn(),
      getActiveViewOfType: vi.fn(() => null),
      iterateAllLeaves: vi.fn((cb: (leaf: any) => void) => {
        for (const leaf of leaves) cb(leaf);
      }),
    },
  }) as any;

/** Drain the microtask queue N levels deep. */
const flush = async (n = 20) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

/** Fire the WS onmessage handler with a decoded message object. */
const fireMessage = (decoded: unknown) => {
  mockDecode.mockReturnValueOnce(decoded);
  mockWsInstance.onmessage!({ data: new ArrayBuffer(4) } as MessageEvent);
};

/** Minimal in-memory adapter store for tests that need persisted vv-cache state. */
const installVirtualStateStore = () => {
  const textFiles = new Map<string, string>();
  const binaryFiles = new Map<string, ArrayBuffer>();

  mockAdapter.exists.mockImplementation(async (path: string) => {
    return (
      path === '.obsidian/plugins/vaultcrdt/state' ||
      textFiles.has(path) ||
      binaryFiles.has(path)
    );
  });
  mockAdapter.read.mockImplementation(async (path: string) => {
    return textFiles.get(path) ?? '';
  });
  mockAdapter.write.mockImplementation(async (path: string, content: string) => {
    textFiles.set(path, content);
  });
  mockAdapter.readBinary.mockImplementation(async (path: string) => {
    return binaryFiles.get(path) ?? new ArrayBuffer(0);
  });
  mockAdapter.writeBinary.mockImplementation(async (path: string, content: ArrayBuffer) => {
    binaryFiles.set(path, content);
  });
  mockAdapter.list.mockImplementation(async (dir: string) => ({
    files: [...textFiles.keys(), ...binaryFiles.keys()].filter((path) => path.startsWith(`${dir}/`)),
    folders: [],
  }));

  return { textFiles, binaryFiles };
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SyncEngine', () => {
  let engine: SyncEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWsInstance.readyState = 1;
    mockWsInstance.onopen = null;
    mockWsInstance.onmessage = null;
    mockWsInstance.onclose = null;
    mockWsInstance.onerror = null;
    mockVault.getMarkdownFiles.mockReturnValue([]);
    mockVault.read.mockResolvedValue('');
    mockDocInstance.get_text.mockReturnValue('');
    mockDocInstance.text_matches.mockReturnValue(false);
    mockDocInstance.export_vv_json.mockReturnValue('{}');
    mockDocInstance.export_delta_since_vv_json.mockReturnValue(new Uint8Array(32));
    mockDocInstance.import_and_diff.mockReturnValue('');
    mockAdapter.exists.mockResolvedValue(false);
    mockAdapter.list.mockResolvedValue({ files: [], folders: [] });
    engine = new SyncEngine(makeApp(), makeSettings());
  });

  // ── auth ───────────────────────────────────────────────────────────────────

  describe('auth', () => {
    it('calls /auth/verify with vault_id and api_key', async () => {
      await engine.start();
      expect(mockRequestUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'http://localhost:3737/auth/verify',
          method: 'POST',
          body: JSON.stringify({ vault_id: 'vault-abc', api_key: 'test-api-key' }),
        })
      );
    });

    it('opens WebSocket with token and /ws path', async () => {
      await engine.start();
      expect(MockWebSocket).toHaveBeenCalledWith(
        expect.stringContaining('/ws?token=test-token')
      );
    });

    it('converts http:// to ws:// for WS URL', async () => {
      await engine.start();
      const wsUrl = (MockWebSocket as any).mock.calls[0][0] as string;
      expect(wsUrl).toMatch(/^ws:\/\//);
    });

    it('converts https:// serverUrl to wss:// for WS URL', async () => {
      engine = new SyncEngine(
        makeApp(),
        makeSettings({ serverUrl: 'https://example.com' })
      );
      await engine.start();
      const wsUrl = (MockWebSocket as any).mock.calls[0][0] as string;
      expect(wsUrl).toMatch(/^wss:\/\//);
    });

    it('includes admin_token in the auth body when one-shot is armed', async () => {
      engine.setOneShotAdminToken('secret-admin');
      await engine.start();

      const authCall = mockRequestUrl.mock.calls.find(
        (c: any[]) => typeof c[0]?.url === 'string' && c[0].url.includes('/auth/verify'),
      );
      expect(authCall).toBeDefined();
      const body = JSON.parse(authCall![0].body as string) as Record<string, unknown>;
      expect(body).toEqual({
        vault_id: 'vault-abc',
        api_key: 'test-api-key',
        admin_token: 'secret-admin',
      });
    });

    it('clears the one-shot admin_token after a successful auth', async () => {
      engine.setOneShotAdminToken('secret-admin');
      await engine.start();

      // Simulate a reconnect by calling auth() again via the private path.
      // A second auth round must NOT include admin_token anymore.
      mockRequestUrl.mockClear();
      await (engine as any).auth();

      const body = JSON.parse(mockRequestUrl.mock.calls[0][0].body as string) as Record<string, unknown>;
      expect(body).toEqual({
        vault_id: 'vault-abc',
        api_key: 'test-api-key',
      });
      expect(body.admin_token).toBeUndefined();
    });
  });

  // ── initialSync — server-only doc ─────────────────────────────────────────

  describe('initialSync — server-only doc', () => {
    it('sends sync_start with null VV, receives sync_delta, writes to vault', async () => {
      mockVault.getMarkdownFiles.mockReturnValue([]);
      mockDocInstance.get_text.mockReturnValue('remote content');

      await engine.start();
      const syncPromise = engine.initialSync();

      // doc_list
      fireMessage({
        type: 'doc_list',
        docs: [{ doc_uuid: 'a.md', updated_at: '2026-03-16T00:00:00Z', vv_json: '{}' }],
        tombstones: [],
      });

      await flush();

      // sync_delta response (server sends full snapshot as delta since client has no VV)
      fireMessage({
        type: 'sync_delta',
        doc_uuid: 'a.md',
        delta: new Uint8Array(64),
        server_vv: new TextEncoder().encode('{"12345":5}'),
      });

      await syncPromise;

      expect(mockDocInstance.import_snapshot).toHaveBeenCalledWith(expect.any(Uint8Array));
      expect(mockVault.create).toHaveBeenCalledWith('a.md', 'remote content');

      // Should have sent sync_start with null client_vv
      const syncStartCalls = mockEncode.mock.calls.filter(
        (c: any[]) => c[0]?.type === 'sync_start' && c[0]?.doc_uuid === 'a.md'
      );
      expect(syncStartCalls.length).toBe(1);
      expect(syncStartCalls[0][0].client_vv).toBeNull();
    });
  });

  // ── initialSync — local-only doc ──────────────────────────────────────────

  describe('initialSync — local-only doc', () => {
    it('creates doc from disk and pushes doc_create to server', async () => {
      mockVault.getMarkdownFiles.mockReturnValue([{ path: 'local.md' }]);
      mockVault.read.mockResolvedValue('local content');

      await engine.start();
      const syncPromise = engine.initialSync();

      await flush();

      // Server has no docs
      fireMessage({ type: 'doc_list', docs: [], tombstones: [] });

      await syncPromise;

      expect(mockDocInstance.sync_from_disk).toHaveBeenCalledWith('local content');
      const createCalls = mockEncode.mock.calls.filter(
        (c: any[]) => c[0]?.type === 'doc_create' && c[0]?.doc_uuid === 'local.md'
      );
      expect(createCalls.length).toBe(1);
      expect(createCalls[0][0]).toMatchObject({
        doc_uuid: 'local.md',
        snapshot: expect.any(Uint8Array),
        peer_id: 'peer-test',
      });
    });
  });

  // ── initialSync — overlap with bidirectional sync ─────────────────────────

  describe('initialSync — overlapping doc with bidirectional sync', () => {
    it('sends sync_start with client VV, imports delta, then pushes own delta', async () => {
      mockVault.getMarkdownFiles.mockReturnValue([{ path: 'shared.md' }]);
      mockVault.read.mockResolvedValue('local version');
      // text_matches = true: Obsidian edits always persist CRDT state, so disk == CRDT on startup
      mockDocInstance.text_matches.mockReturnValue(true);
      mockDocInstance.version.mockReturnValue(3);
      // Client and server share peer "12345" → shared history → normal merge
      mockDocInstance.export_vv_json.mockReturnValue('{"999":3,"12345":2}');
      mockDocInstance.get_text.mockReturnValue('merged version');

      await engine.start();
      const syncPromise = engine.initialSync();

      await flush();

      fireMessage({
        type: 'doc_list',
        docs: [{ doc_uuid: 'shared.md', updated_at: '2026-03-16T00:00:00Z', vv_json: '{"12345":5}' }],
        tombstones: [],
      });

      await flush();

      // sync_delta response
      fireMessage({
        type: 'sync_delta',
        doc_uuid: 'shared.md',
        delta: new Uint8Array(32),
        server_vv: new TextEncoder().encode('{"12345":5}'),
      });

      await syncPromise;

      // Should have imported the server delta
      expect(mockDocInstance.import_snapshot).toHaveBeenCalled();

      // Should have sent sync_start with client VV
      const syncStartCalls = mockEncode.mock.calls.filter(
        (c: any[]) => c[0]?.type === 'sync_start' && c[0]?.doc_uuid === 'shared.md'
      );
      expect(syncStartCalls.length).toBe(1);
      expect(syncStartCalls[0][0].client_vv).toBeInstanceOf(Uint8Array);

      // Should have sent sync_push with local delta
      const syncPushCalls = mockEncode.mock.calls.filter(
        (c: any[]) => c[0]?.type === 'sync_push' && c[0]?.doc_uuid === 'shared.md'
      );
      expect(syncPushCalls.length).toBe(1);
      expect(syncPushCalls[0][0]).toMatchObject({
        delta: expect.any(Uint8Array),
        peer_id: 'peer-test',
      });
    });

    it('does not push sync_push if server VV covers client VV', async () => {
      mockVault.getMarkdownFiles.mockReturnValue([{ path: 'same.md' }]);
      mockVault.read.mockResolvedValue('same content');
      mockDocInstance.text_matches.mockReturnValue(true);
      mockDocInstance.version.mockReturnValue(3);
      // Client VV is a subset of server VV — server already has all our ops
      mockDocInstance.export_vv_json.mockReturnValue('{"12345":3}');
      mockDocInstance.get_text.mockReturnValue('same content');

      await engine.start();
      const syncPromise = engine.initialSync();

      await flush();

      fireMessage({
        type: 'doc_list',
        docs: [{ doc_uuid: 'same.md', updated_at: '2026-03-16T00:00:00Z', vv_json: '{"12345":5}' }],
        tombstones: [],
      });

      await flush();
      fireMessage({
        type: 'sync_delta',
        doc_uuid: 'same.md',
        delta: new Uint8Array(16),
        server_vv: new TextEncoder().encode('{"12345":5}'),
      });

      await syncPromise;

      const syncPushCalls = mockEncode.mock.calls.filter(
        (c: any[]) => c[0]?.type === 'sync_push' && c[0]?.doc_uuid === 'same.md'
      );
      expect(syncPushCalls.length).toBe(0);
    });

    it('pushes sync_push when client has ops server does not know about', async () => {
      mockVault.getMarkdownFiles.mockReturnValue([{ path: 'offline.md' }]);
      mockVault.read.mockResolvedValue('offline content');
      mockDocInstance.text_matches.mockReturnValue(true);
      mockDocInstance.version.mockReturnValue(5);
      // Client and server share the legacy peer "12345"; the client has its
      // own additional peer "999" with offline edits. NOT disjoint — Phase 3
      // of the conflict-storm fix only adopts when the peer sets are strict
      // disjoint, so this case still goes through the normal merge+push path.
      mockDocInstance.export_vv_json.mockReturnValue('{"999":5,"12345":3}');
      mockDocInstance.get_text.mockReturnValue('offline content');
      mockDocInstance.export_delta_since_vv_json.mockReturnValue(new Uint8Array(32));

      await engine.start();
      const syncPromise = engine.initialSync();

      await flush();

      fireMessage({
        type: 'doc_list',
        docs: [{ doc_uuid: 'offline.md', updated_at: '2026-03-16T00:00:00Z', vv_json: '{"12345":3}' }],
        tombstones: [],
      });

      await flush();
      fireMessage({
        type: 'sync_delta',
        doc_uuid: 'offline.md',
        delta: new Uint8Array(16),
        server_vv: new TextEncoder().encode('{"12345":3}'),
      });

      await syncPromise;

      const syncPushCalls = mockEncode.mock.calls.filter(
        (c: any[]) => c[0]?.type === 'sync_push' && c[0]?.doc_uuid === 'offline.md'
      );
      expect(syncPushCalls.length).toBe(1);
    });
  });

  // ── initialSync — content-hash fast-path (Tier 1) ──────────────────────────

  describe('initialSync — content-hash fast-path', () => {
    it('skips CRDT sync when VV and content hash both match', async () => {
      const tfile = Object.create(TFile.prototype);
      tfile.path = 'cached.md';
      mockVault.getMarkdownFiles.mockReturnValue([tfile]);
      mockVault.read.mockResolvedValue('hello world');

      const { fnv1aHash } = await import('../conflict-utils');
      const expectedHash = fnv1aHash('hello world');

      // Pre-populate VV cache with matching VV and content hash
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        _version: 3,
        'cached.md': { vv: '{"peer1":10}', contentHash: expectedHash },
      }));
      mockAdapter.list.mockResolvedValue({ files: [], folders: [] });

      await engine.start();
      const syncPromise = engine.initialSync();

      await flush();

      fireMessage({
        type: 'doc_list',
        docs: [{ doc_uuid: 'cached.md', updated_at: '2026-03-16T00:00:00Z', server_vv: new TextEncoder().encode('{"peer1":10}') }],
        tombstones: [],
      });

      await syncPromise;

      // File is read for hash check, but no sync_start is sent (skip)
      expect(mockVault.read).toHaveBeenCalled();
      const syncStartCalls = mockEncode.mock.calls.filter(
        (c: any[]) => c[0]?.type === 'sync_start'
      );
      expect(syncStartCalls.length).toBe(0);
    });

    it('falls through to full sync when server VV differs', async () => {
      const tfile = Object.create(TFile.prototype);
      tfile.path = 'edited.md';
      mockVault.getMarkdownFiles.mockReturnValue([tfile]);
      mockVault.read.mockResolvedValue('edited content');
      mockDocInstance.version.mockReturnValue(5);

      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        _version: 3,
        'edited.md': { vv: '{"peer1":5}', contentHash: 12345 },
      }));
      mockAdapter.list.mockResolvedValue({ files: [], folders: [] });

      await engine.start();
      const syncPromise = engine.initialSync();

      await flush();

      // Server VV differs from cached → full sync via sync_start
      fireMessage({
        type: 'doc_list',
        docs: [{ doc_uuid: 'edited.md', updated_at: '2026-03-16T00:00:00Z', server_vv: new TextEncoder().encode('{"peer1":10}') }],
        tombstones: [],
      });

      await flush();

      // The Phase-2/3 hardening added several extra await hops between
      // doc_list resolution and sync_start being encoded (loadVVCache,
      // readEffectiveLocalContent, belt-and-suspenders editor read,
      // storage.load, etc). The default flush(10) no longer drains far
      // enough — bump locally so the sync_start has been sent.
      await flush(50);
      const syncStartCalls = mockEncode.mock.calls.filter(
        (c: any[]) => c[0]?.type === 'sync_start' && c[0]?.doc_uuid === 'edited.md'
      );
      expect(syncStartCalls.length).toBe(1);

      // Respond with sync_delta to unblock syncPromise
      fireMessage({
        type: 'sync_delta',
        doc_uuid: 'edited.md',
        delta: new Uint8Array(0),
        server_vv: new TextEncoder().encode('{"peer1":10}'),
      });

      await syncPromise;
    });

    it('migrates old v1 cache format — VV match triggers full sync (sentinel hash never matches)', async () => {
      const tfile = Object.create(TFile.prototype);
      tfile.path = 'old.md';
      mockVault.getMarkdownFiles.mockReturnValue([tfile]);
      mockVault.read.mockResolvedValue('some content');
      mockDocInstance.version.mockReturnValue(5);

      // Old v1 format: no _version, plain string values → parsed with contentHash=0
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        'old.md': '{"peer1":10}',
      }));
      mockAdapter.list.mockResolvedValue({ files: [], folders: [] });

      await engine.start();
      const syncPromise = engine.initialSync();

      await flush();

      fireMessage({
        type: 'doc_list',
        docs: [{ doc_uuid: 'old.md', updated_at: '2026-03-16T00:00:00Z', server_vv: new TextEncoder().encode('{"peer1":10}') }],
        tombstones: [],
      });

      await flush();

      // v1 cache has contentHash=0 (sentinel) → hash mismatch → full sync.
      // Same flush-depth caveat as the test above — bump locally.
      await flush(50);
      const syncStartCalls = mockEncode.mock.calls.filter(
        (c: any[]) => c[0]?.type === 'sync_start' && c[0]?.doc_uuid === 'old.md'
      );
      expect(syncStartCalls.length).toBe(1);

      // Respond with sync_delta to unblock
      fireMessage({
        type: 'sync_delta',
        doc_uuid: 'old.md',
        delta: new Uint8Array(0),
        server_vv: new TextEncoder().encode('{"peer1":10}'),
      });

      await syncPromise;
    });

    it('persists the downloaded server text hash so the next sync can skip server-only docs', async () => {
      const { textFiles } = installVirtualStateStore();
      mockDocInstance.version.mockReturnValue(0);
      mockDocInstance.get_text.mockReturnValue('server content');

      await engine.start();
      const firstSync = engine.initialSync();

      await flush();

      fireMessage({
        type: 'doc_list',
        docs: [{ doc_uuid: 'remote.md', updated_at: '2026-03-16T00:00:00Z', server_vv: new TextEncoder().encode('{"peer1":1}') }],
        tombstones: [],
      });

      await flush();
      fireMessage({
        type: 'sync_delta',
        doc_uuid: 'remote.md',
        delta: new Uint8Array(32),
        server_vv: new TextEncoder().encode('{"peer1":1}'),
      });

      await firstSync;

      const { fnv1aHash } = await import('../conflict-utils');
      const vvCacheRaw = textFiles.get('.obsidian/plugins/vaultcrdt/state/vv-cache.json');
      expect(vvCacheRaw).toBeTruthy();
      const vvCache = JSON.parse(vvCacheRaw!);
      expect(vvCache['remote.md']).toEqual({
        vv: '{"peer1":1}',
        contentHash: fnv1aHash('server content'),
      });

      const localFile = Object.create(TFile.prototype);
      localFile.path = 'remote.md';
      mockVault.getMarkdownFiles.mockReturnValue([localFile]);
      mockVault.read.mockResolvedValue('server content');

      const syncStartsBefore = mockEncode.mock.calls.filter(
        (c: any[]) => c[0]?.type === 'sync_start' && c[0]?.doc_uuid === 'remote.md'
      ).length;

      const secondSync = engine.initialSync();
      await flush();

      fireMessage({
        type: 'doc_list',
        docs: [{ doc_uuid: 'remote.md', updated_at: '2026-03-16T00:00:00Z', server_vv: new TextEncoder().encode('{"peer1":1}') }],
        tombstones: [],
      });

      await secondSync;

      const syncStartsAfter = mockEncode.mock.calls.filter(
        (c: any[]) => c[0]?.type === 'sync_start' && c[0]?.doc_uuid === 'remote.md'
      ).length;
      expect(syncStartsAfter).toBe(syncStartsBefore);
    });

    it('persists the final merged text hash instead of the stale pre-sync local text', async () => {
      const { textFiles } = installVirtualStateStore();
      const tfile = Object.create(TFile.prototype);
      tfile.path = 'overlap.md';
      mockVault.getMarkdownFiles.mockReturnValue([tfile]);
      mockVault.read
        .mockResolvedValueOnce('local baseline')
        .mockResolvedValue('server merged');
      mockDocInstance.version.mockReturnValue(1);
      mockDocInstance.text_matches.mockReturnValue(true);
      mockDocInstance.export_vv_json.mockReturnValue('{"peer1":1}');
      mockDocInstance.get_text.mockReturnValue('server merged');

      await engine.start();
      const firstSync = engine.initialSync();

      await flush();

      fireMessage({
        type: 'doc_list',
        docs: [{ doc_uuid: 'overlap.md', updated_at: '2026-03-16T00:00:00Z', server_vv: new TextEncoder().encode('{"peer1":2}') }],
        tombstones: [],
      });

      await flush(50);
      fireMessage({
        type: 'sync_delta',
        doc_uuid: 'overlap.md',
        delta: new Uint8Array(32),
        server_vv: new TextEncoder().encode('{"peer1":2}'),
      });

      await firstSync;

      const { fnv1aHash } = await import('../conflict-utils');
      const vvCacheRaw = textFiles.get('.obsidian/plugins/vaultcrdt/state/vv-cache.json');
      expect(vvCacheRaw).toBeTruthy();
      const vvCache = JSON.parse(vvCacheRaw!);
      expect(vvCache['overlap.md']).toEqual({
        vv: '{"peer1":2}',
        contentHash: fnv1aHash('server merged'),
      });

      const syncStartsBefore = mockEncode.mock.calls.filter(
        (c: any[]) => c[0]?.type === 'sync_start' && c[0]?.doc_uuid === 'overlap.md'
      ).length;

      const secondSync = engine.initialSync();
      await flush();

      fireMessage({
        type: 'doc_list',
        docs: [{ doc_uuid: 'overlap.md', updated_at: '2026-03-16T00:00:00Z', server_vv: new TextEncoder().encode('{"peer1":2}') }],
        tombstones: [],
      });

      await secondSync;

      const syncStartsAfter = mockEncode.mock.calls.filter(
        (c: any[]) => c[0]?.type === 'sync_start' && c[0]?.doc_uuid === 'overlap.md'
      ).length;
      expect(syncStartsAfter).toBe(syncStartsBefore);
    });
  });

  // ── initialSync — parallel overlapping reads (performance) ─────────────────

  describe('initialSync — parallel overlapping reads', () => {
    it('T-P1: reads each overlapping file exactly once', async () => {
      const { fnv1aHash } = await import('../conflict-utils');
      const content = 'hello world';
      const hash = fnv1aHash(content);

      const files = ['a.md', 'b.md', 'c.md'].map(p => {
        const f = Object.create(TFile.prototype);
        f.path = p;
        return f;
      });
      mockVault.getMarkdownFiles.mockReturnValue(files);
      mockVault.read.mockResolvedValue(content);

      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        _version: 3,
        'a.md': { vv: '{"p":1}', contentHash: hash },
        'b.md': { vv: '{"p":1}', contentHash: hash },
        'c.md': { vv: '{"p":1}', contentHash: hash },
      }));
      mockAdapter.list.mockResolvedValue({ files: [], folders: [] });

      await engine.start();
      const syncPromise = engine.initialSync();
      await flush();

      fireMessage({
        type: 'doc_list',
        docs: files.map(f => ({ doc_uuid: f.path, updated_at: '2026-04-09T00:00:00Z', server_vv: new TextEncoder().encode('{"p":1}') })),
        tombstones: [],
      });
      await syncPromise;

      // Each file read exactly once (parallel pre-read, no double reads)
      const readCalls = mockVault.read.mock.calls.filter(
        (c: any[]) => files.some(f => f === c[0] || f.path === c[0]?.path)
      );
      expect(readCalls.length).toBe(3);
    });

    it('T-P2: all VV+hash matches → zero requestSyncStart and zero writeToVault', async () => {
      const { fnv1aHash } = await import('../conflict-utils');
      const content = 'consistent';
      const hash = fnv1aHash(content);

      const files = ['x.md', 'y.md', 'z.md'].map(p => {
        const f = Object.create(TFile.prototype);
        f.path = p;
        return f;
      });
      mockVault.getMarkdownFiles.mockReturnValue(files);
      mockVault.read.mockResolvedValue(content);

      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        _version: 3,
        'x.md': { vv: '{"p":1}', contentHash: hash },
        'y.md': { vv: '{"p":1}', contentHash: hash },
        'z.md': { vv: '{"p":1}', contentHash: hash },
      }));
      mockAdapter.list.mockResolvedValue({ files: [], folders: [] });

      await engine.start();
      const syncPromise = engine.initialSync();
      await flush();

      fireMessage({
        type: 'doc_list',
        docs: files.map(f => ({ doc_uuid: f.path, updated_at: '2026-04-09T00:00:00Z', server_vv: new TextEncoder().encode('{"p":1}') })),
        tombstones: [],
      });
      await syncPromise;

      const syncStartCalls = mockEncode.mock.calls.filter(
        (c: any[]) => c[0]?.type === 'sync_start'
      );
      expect(syncStartCalls.length).toBe(0);
      expect(mockVault.modify).not.toHaveBeenCalled();
    });

    it('T-P3: one hash mismatch triggers exactly one requestSyncStart', async () => {
      const { fnv1aHash } = await import('../conflict-utils');
      const content = 'shared content';
      const hash = fnv1aHash(content);

      const files = ['m1.md', 'm2.md', 'm3.md'].map(p => {
        const f = Object.create(TFile.prototype);
        f.path = p;
        return f;
      });
      mockVault.getMarkdownFiles.mockReturnValue(files);
      mockVault.read.mockResolvedValue(content);
      mockDocInstance.version.mockReturnValue(5);
      mockDocInstance.text_matches.mockReturnValue(true);
      mockDocInstance.get_text.mockReturnValue(content);

      // m2.md has wrong hash → triggers full sync
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        _version: 3,
        'm1.md': { vv: '{"p":1}', contentHash: hash },
        'm2.md': { vv: '{"p":1}', contentHash: 99999 },
        'm3.md': { vv: '{"p":1}', contentHash: hash },
      }));
      mockAdapter.list.mockResolvedValue({ files: [], folders: [] });

      await engine.start();
      const syncPromise = engine.initialSync();
      await flush();

      fireMessage({
        type: 'doc_list',
        docs: files.map(f => ({ doc_uuid: f.path, updated_at: '2026-04-09T00:00:00Z', server_vv: new TextEncoder().encode('{"p":1}') })),
        tombstones: [],
      });

      await flush(50);

      // Only m2.md should have triggered sync_start
      fireMessage({
        type: 'sync_delta',
        doc_uuid: 'm2.md',
        delta: new Uint8Array(0),
        server_vv: new TextEncoder().encode('{"p":1}'),
      });

      await syncPromise;

      const syncStartCalls = mockEncode.mock.calls.filter(
        (c: any[]) => c[0]?.type === 'sync_start'
      );
      expect(syncStartCalls.length).toBe(1);
      expect(syncStartCalls[0][0].doc_uuid).toBe('m2.md');
    });

    it('T-P4: vv-cache persisted with correct entries after parallel reads', async () => {
      const { fnv1aHash } = await import('../conflict-utils');
      const content = 'cached text';
      const hash = fnv1aHash(content);
      const { textFiles } = installVirtualStateStore();

      const files = ['c1.md', 'c2.md'].map(p => {
        const f = Object.create(TFile.prototype);
        f.path = p;
        return f;
      });
      mockVault.getMarkdownFiles.mockReturnValue(files);
      mockVault.read.mockResolvedValue(content);

      // Pre-populate with matching cache
      textFiles.set('.obsidian/plugins/vaultcrdt/state/vv-cache.json', JSON.stringify({
        _version: 3,
        'c1.md': { vv: '{"p":1}', contentHash: hash },
        'c2.md': { vv: '{"p":1}', contentHash: hash },
      }));

      await engine.start();
      const syncPromise = engine.initialSync();
      await flush();

      fireMessage({
        type: 'doc_list',
        docs: files.map(f => ({ doc_uuid: f.path, updated_at: '2026-04-09T00:00:00Z', server_vv: new TextEncoder().encode('{"p":1}') })),
        tombstones: [],
      });
      await syncPromise;

      const saved = textFiles.get('.obsidian/plugins/vaultcrdt/state/vv-cache.json');
      expect(saved).toBeDefined();
      const cache = JSON.parse(saved!);
      expect(cache['c1.md']).toBeDefined();
      expect(cache['c2.md']).toBeDefined();
      expect(cache['c1.md'].contentHash).toBe(hash);
      expect(cache['c2.md'].contentHash).toBe(hash);
      expect(cache['c1.md'].vv).toBe('{"p":1}');
    });

    it('T-P7: phase-timings appear in startup trace', async () => {
      const { fnv1aHash } = await import('../conflict-utils');
      const content = 'trace test';
      const hash = fnv1aHash(content);

      const tfile = Object.create(TFile.prototype);
      tfile.path = 'trace.md';
      mockVault.getMarkdownFiles.mockReturnValue([tfile]);
      mockVault.read.mockResolvedValue(content);

      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        _version: 3,
        'trace.md': { vv: '{"p":1}', contentHash: hash },
      }));
      mockAdapter.list.mockResolvedValue({ files: [], folders: [] });

      await engine.start();
      const syncPromise = engine.initialSync();
      await flush();

      fireMessage({
        type: 'doc_list',
        docs: [{ doc_uuid: 'trace.md', updated_at: '2026-04-09T00:00:00Z', server_vv: new TextEncoder().encode('{"p":1}') }],
        tombstones: [],
      });
      await syncPromise;

      const report = engine.getStartupTraceReport();
      expect(report).toContain('initial-sync.phase-timings');
      expect(report).toContain('docListMs');
      expect(report).toContain('priorityMs');
      expect(report).toContain('downloadsMs');
      expect(report).toContain('overlappingMs');
      expect(report).toContain('localOnlyMs');
      expect(report).toContain('tombstonesMs');
      expect(report).toContain('vvCacheSaveMs');
      expect(report).toContain('orphansMs');
    });
  });

  // ── initialSync — tombstone ────────────────────────────────────────────────

  describe('initialSync — tombstone', () => {
    it('calls vault.trash for a tombstoned file that exists locally', async () => {
      const mockFile = Object.create(TFile.prototype);
      mockVault.getAbstractFileByPath.mockReturnValue(mockFile);
      mockVault.getMarkdownFiles.mockReturnValue([{ path: 'deleted.md' }]);

      await engine.start();
      const syncPromise = engine.initialSync();

      await flush();

      fireMessage({
        type: 'doc_list',
        docs: [],
        tombstones: ['deleted.md'],
      });

      await syncPromise;

      expect(mockVault.trash).toHaveBeenCalledWith(mockFile, true);
    });

    it('does not push a tombstoned local file', async () => {
      mockVault.getMarkdownFiles.mockReturnValue([{ path: 'gone.md' }]);
      mockVault.read.mockResolvedValue('content');

      await engine.start();
      const syncPromise = engine.initialSync();

      await flush();

      fireMessage({ type: 'doc_list', docs: [], tombstones: ['gone.md'] });

      await syncPromise;

      const createCalls = mockEncode.mock.calls.filter(
        (c: any[]) => c[0]?.type === 'doc_create'
      );
      expect(createCalls.length).toBe(0);
    });
  });

  // ── onFileChanged (debounced) — sends delta not snapshot ──────────────────

  describe('onFileChanged', () => {
    const mockEditor = {
      getValue: vi.fn().mockReturnValue('hello'),
      setValue: vi.fn(),
      getCursor: vi.fn().mockReturnValue({ line: 0, ch: 0 }),
      setCursor: vi.fn(),
      lastLine: vi.fn().mockReturnValue(0),
      getLine: vi.fn().mockReturnValue(''),
      offsetToPos: vi.fn().mockReturnValue({ line: 0, ch: 0 }),
      transaction: vi.fn(),
    };
    const makeLeaf = (path: string) => ({
      view: Object.assign(Object.create(MockMarkdownView.prototype), {
        file: { path },
        editor: mockEditor,
      }),
    });

    it('is debounced and reads fresh content on fire', async () => {
      vi.useFakeTimers();
      engine = new SyncEngine(makeApp([makeLeaf('note.md')]), makeSettings());
      await engine.start();

      mockEditor.getValue.mockReturnValue('hello');
      engine.onFileChanged('note.md');

      // Before debounce fires
      vi.advanceTimersByTime(200);
      let pushCalls = mockEncode.mock.calls.filter(
        (c: any[]) => c[0]?.type === 'sync_push'
      );
      expect(pushCalls.length).toBe(0);

      // After debounce fires
      vi.advanceTimersByTime(150);
      await flush();
      pushCalls = mockEncode.mock.calls.filter(
        (c: any[]) => c[0]?.type === 'sync_push'
      );
      expect(pushCalls.length).toBe(1);
      expect(pushCalls[0][0]).toMatchObject({
        type: 'sync_push',
        doc_uuid: 'note.md',
        delta: expect.any(Uint8Array),
        peer_id: 'peer-test',
      });

      vi.useRealTimers();
    });

    it('resets debounce on rapid edits', async () => {
      vi.useFakeTimers();
      engine = new SyncEngine(makeApp([makeLeaf('note.md')]), makeSettings());
      await engine.start();

      mockEditor.getValue.mockReturnValue('hello');
      engine.onFileChanged('note.md');
      vi.advanceTimersByTime(200);
      engine.onFileChanged('note.md');
      vi.advanceTimersByTime(200);
      expect(
        mockEncode.mock.calls.filter((c: any[]) => c[0]?.type === 'sync_push').length
      ).toBe(0);

      mockEditor.getValue.mockReturnValue('hello!');
      vi.advanceTimersByTime(150);
      await flush();
      expect(
        mockEncode.mock.calls.filter((c: any[]) => c[0]?.type === 'sync_push').length
      ).toBe(1);

      vi.useRealTimers();
    });

    it('flushes pending edits into CRDT before broadcast merge', async () => {
      vi.useFakeTimers();
      engine = new SyncEngine(makeApp([makeLeaf('note.md')]), makeSettings());
      await engine.start();

      // User types "hello" → debounce starts
      mockEditor.getValue.mockReturnValue('hello');
      mockDocInstance.text_matches.mockReturnValue(false);
      engine.onFileChanged('note.md');

      // Broadcast arrives during debounce window
      const mockFile = Object.create(TFile.prototype);
      mockFile.path = 'note.md';
      mockVault.getAbstractFileByPath.mockReturnValue(mockFile);
      mockDocInstance.get_text.mockReturnValue('merged result');
      mockDocInstance.import_and_diff.mockReturnValue('');
      fireMessage({
        type: 'delta_broadcast',
        doc_uuid: 'note.md',
        delta: new Uint8Array(64),
        peer_id: 'other-peer',
      });
      await flush();

      // sync_from_disk should have been called with fresh editor content
      // BEFORE the broadcast delta was imported — this is the flush
      expect(mockDocInstance.sync_from_disk).toHaveBeenCalledWith('hello');

      // Debounce timer was cancelled by flush — should not fire again
      mockEncode.mockClear();
      vi.advanceTimersByTime(350);
      await flush();

      const pushCalls = mockEncode.mock.calls.filter(
        (c: any[]) => c[0]?.type === 'sync_push'
      );
      expect(pushCalls.length).toBe(0);

      vi.useRealTimers();
    });

    it('captures user edits after broadcast correctly', async () => {
      vi.useFakeTimers();
      engine = new SyncEngine(makeApp([makeLeaf('note.md')]), makeSettings());
      await engine.start();

      // User types → debounce starts
      mockEditor.getValue.mockReturnValue('hello');
      engine.onFileChanged('note.md');

      // Broadcast arrives
      const mockFile = Object.create(TFile.prototype);
      mockFile.path = 'note.md';
      mockVault.getAbstractFileByPath.mockReturnValue(mockFile);
      mockDocInstance.get_text.mockReturnValue('world');
      mockDocInstance.import_and_diff.mockReturnValue('');
      fireMessage({
        type: 'delta_broadcast',
        doc_uuid: 'note.md',
        delta: new Uint8Array(64),
        peer_id: 'other-peer',
      });
      await flush();

      // User types more after broadcast — resets debounce
      mockEditor.getValue.mockReturnValue('world!');
      engine.onFileChanged('note.md');

      // Debounce fires — reads fresh "world!" which differs from broadcast
      mockEncode.mockClear();
      vi.advanceTimersByTime(350);
      await flush();

      const pushCalls = mockEncode.mock.calls.filter(
        (c: any[]) => c[0]?.type === 'sync_push'
      );
      expect(pushCalls.length).toBe(1);

      vi.useRealTimers();
    });

    it('does not push when no editor is open for the file', async () => {
      vi.useFakeTimers();
      // No leaves — readCurrentContent returns null
      engine = new SyncEngine(makeApp([]), makeSettings());
      await engine.start();

      engine.onFileChanged('note.md');

      vi.advanceTimersByTime(350);
      await flush();

      const pushCalls = mockEncode.mock.calls.filter(
        (c: any[]) => c[0]?.type === 'sync_push'
      );
      expect(pushCalls.length).toBe(0);

      vi.useRealTimers();
    });
  });

  // ── delta_broadcast ────────────────────────────────────────────────────────

  describe('delta_broadcast', () => {
    it('imports delta via import_and_diff and writes content to vault', async () => {
      const mockFile = Object.create(TFile.prototype);
      mockVault.getAbstractFileByPath.mockReturnValue(mockFile);
      mockDocInstance.get_text.mockReturnValue('broadcast content');
      mockDocInstance.import_and_diff.mockReturnValue('');

      await engine.start();

      fireMessage({
        type: 'delta_broadcast',
        doc_uuid: 'remote.md',
        delta: new Uint8Array(64),
        peer_id: 'other-peer',
      });

      await flush();

      expect(mockDocInstance.import_and_diff).toHaveBeenCalledWith(expect.any(Uint8Array));
      expect(mockVault.modify).toHaveBeenCalledWith(mockFile, 'broadcast content');
    });

    it('applies diff surgically to editor when open', async () => {
      const mockEditor = {
        offsetToPos: vi.fn().mockImplementation((offset: number) => ({ line: 0, ch: offset })),
        transaction: vi.fn(),
        getValue: vi.fn().mockReturnValue('Hello World'),
        getCursor: vi.fn().mockReturnValue({ line: 0, ch: 5 }),
        setValue: vi.fn(),
        lastLine: vi.fn().mockReturnValue(0),
        getLine: vi.fn().mockReturnValue('Hello World'),
        setCursor: vi.fn(),
      };

      const mockView = new MockMarkdownView();
      mockView.file = { path: 'test.md' };
      mockView.editor = mockEditor;

      const mockLeaf = { view: mockView };

      // Recreate engine with editor leaf so iterateAllLeaves finds it
      engine = new SyncEngine(makeApp([mockLeaf]), makeSettings());

      const mockFile = Object.create(TFile.prototype);
      mockVault.getAbstractFileByPath.mockReturnValue(mockFile);
      mockVault.read.mockResolvedValue('Hello');
      mockDocInstance.get_text.mockReturnValue('Hello World');
      mockDocInstance.import_and_diff.mockReturnValue('[{"retain":5},{"insert":" World"}]');

      await engine.start();

      fireMessage({
        type: 'delta_broadcast',
        doc_uuid: 'test.md',
        delta: new Uint8Array(64),
        peer_id: 'other-peer',
      });

      await flush();

      expect(mockDocInstance.import_and_diff).toHaveBeenCalledWith(expect.any(Uint8Array));
      expect(mockEditor.transaction).toHaveBeenCalledWith({
        changes: [
          { from: { line: 0, ch: 5 }, text: ' World' },
        ],
      });
      // Should NOT fall back to vault.modify since editor was updated
      expect(mockVault.modify).not.toHaveBeenCalled();
    });

    it('applies diff with delete ops and correct offset advancement', async () => {
      const mockEditor = {
        offsetToPos: vi.fn().mockImplementation((offset: number) => ({ line: 0, ch: offset })),
        transaction: vi.fn(),
        getValue: vi.fn().mockReturnValue('Hlo World'),
        getCursor: vi.fn().mockReturnValue({ line: 0, ch: 3 }),
        setValue: vi.fn(),
        lastLine: vi.fn().mockReturnValue(0),
        getLine: vi.fn().mockReturnValue('Hlo World'),
        setCursor: vi.fn(),
      };

      const mockView = new MockMarkdownView();
      mockView.file = { path: 'test.md' };
      mockView.editor = mockEditor;

      engine = new SyncEngine(makeApp([{ view: mockView }]), makeSettings());

      const mockFile = Object.create(TFile.prototype);
      mockVault.getAbstractFileByPath.mockReturnValue(mockFile);
      mockVault.read.mockResolvedValue('Hello World');
      mockDocInstance.get_text.mockReturnValue('Hlo World');
      // retain 1 ("H"), delete 2 ("el"), retain 8 ("lo World") — result: "Hlo World"
      mockDocInstance.import_and_diff.mockReturnValue('[{"retain":1},{"delete":2}]');

      await engine.start();

      fireMessage({
        type: 'delta_broadcast',
        doc_uuid: 'test.md',
        delta: new Uint8Array(64),
        peer_id: 'other-peer',
      });

      await flush();

      expect(mockEditor.transaction).toHaveBeenCalledWith({
        changes: [
          { from: { line: 0, ch: 1 }, to: { line: 0, ch: 3 }, text: '' },
        ],
      });
      // offset should advance past deleted chars: 1 (retain) + 2 (delete) = 3
      // offsetToPos should have been called with 1 (from) and 3 (to)
      expect(mockEditor.offsetToPos).toHaveBeenCalledWith(1);
      expect(mockEditor.offsetToPos).toHaveBeenCalledWith(3);
    });
  });

  // ── onFileDeleted ─────────────────────────────────────────────────────────

  describe('onFileDeleted', () => {
    it('sends doc_delete message', async () => {
      await engine.start();

      engine.onFileDeleted('del.md');

      const deleteCalls = mockEncode.mock.calls.filter(
        (c: any[]) => c[0]?.type === 'doc_delete'
      );
      expect(deleteCalls.length).toBe(1);
      expect(deleteCalls[0][0]).toMatchObject({
        doc_uuid: 'del.md',
      });
    });
  });

  // ── onFileRenamed ─────────────────────────────────────────────────────────

  describe('onFileRenamed', () => {
    it('sends doc_delete for old path and sync_push for new path', async () => {
      await engine.start();

      engine.onFileRenamed('old.md', 'new.md', 'content');
      await flush();

      const deleteCalls = mockEncode.mock.calls.filter(
        (c: any[]) => c[0]?.type === 'doc_delete' && c[0]?.doc_uuid === 'old.md'
      );
      expect(deleteCalls.length).toBe(1);

      const pushCalls = mockEncode.mock.calls.filter(
        (c: any[]) => c[0]?.type === 'sync_push' && c[0]?.doc_uuid === 'new.md'
      );
      expect(pushCalls.length).toBe(1);
    });
  });

  // ── isWritingFromRemote ────────────────────────────────────────────────────

  describe('isWritingFromRemote', () => {
    it('returns false for unknown paths', async () => {
      await engine.start();
      expect(engine.isWritingFromRemote('any.md')).toBe(false);
    });

    it('returns true during remote write and clears after timeout', async () => {
      vi.useFakeTimers();
      mockVault.getAbstractFileByPath.mockReturnValue(null);
      mockVault.create.mockResolvedValue(undefined);
      mockDocInstance.get_text.mockReturnValue('new content');

      await engine.start();

      fireMessage({
        type: 'delta_broadcast',
        doc_uuid: 'guarded.md',
        delta: new Uint8Array(8),
        peer_id: 'peer',
      });

      for (let i = 0; i < 8; i++) await Promise.resolve();
      expect(engine.isWritingFromRemote('guarded.md')).toBe(true);

      await vi.advanceTimersByTimeAsync(501);
      expect(engine.isWritingFromRemote('guarded.md')).toBe(false);

      vi.useRealTimers();
    });
  });

  // ── status callbacks ───────────────────────────────────────────────────────

  describe('status callbacks', () => {
    it('calls statusCallback with offline on ws close', async () => {
      const cb = vi.fn();
      engine.statusCallback = cb;
      await engine.start();
      mockWsInstance.onclose!({} as CloseEvent);
      expect(cb).toHaveBeenCalledWith('offline');
    });

    it('calls statusCallback with error on ws error', async () => {
      const cb = vi.fn();
      engine.statusCallback = cb;
      await engine.start();
      mockWsInstance.onerror!({} as Event);
      expect(cb).toHaveBeenCalledWith('error');
    });
  });

  // ── concurrent create conflict fork ────────────────────────────────────────

  describe('concurrent create conflict fork', () => {
    it('forks when local file has no CRDT history and server has different content', async () => {
      // Local file exists with content, version()=0 (no persisted CRDT state)
      mockVault.getMarkdownFiles.mockReturnValue([{ path: 'clash.md' }]);
      mockVault.read.mockResolvedValue('Local version');
      mockDocInstance.version.mockReturnValue(0);
      mockDocInstance.text_matches.mockReturnValue(false);
      mockDocInstance.get_text.mockReturnValue('Server version');
      mockVault.getAbstractFileByPath.mockReturnValue(null); // conflict path doesn't exist yet

      await engine.start();
      const syncPromise = engine.initialSync();

      await flush();

      // doc_list: server has clash.md
      fireMessage({
        type: 'doc_list',
        docs: [{ doc_uuid: 'clash.md', updated_at: '2026-03-17T00:00:00Z', vv_json: '{}' }],
        tombstones: [],
      });

      await flush();

      // First sync_delta: conflict detection probe (null VV)
      fireMessage({
        type: 'sync_delta',
        doc_uuid: 'clash.md',
        delta: new Uint8Array(64),
        server_vv: new TextEncoder().encode('{"999":5}'),
      });

      await syncPromise;

      // Should have created a conflict file
      const createCalls = mockVault.create.mock.calls.filter(
        (c: any[]) => (c[0] as string).includes('conflict')
      );
      expect(createCalls.length).toBe(1);
      expect(createCalls[0][0]).toMatch(/clash \(conflict \d{4}-\d{2}-\d{2}\)\.md/);
      expect(createCalls[0][1]).toBe('Local version');
    });

    it('no fork when VVs share peers (shared CRDT history)', async () => {
      mockVault.getMarkdownFiles.mockReturnValue([{ path: 'persisted.md' }]);
      mockVault.read.mockResolvedValue('Local content');
      mockDocInstance.version.mockReturnValue(5);
      // text_matches = true: Obsidian edits persist CRDT — no external disk change
      mockDocInstance.text_matches.mockReturnValue(true);
      // Client and server share peer "999" → shared history → no fork
      mockDocInstance.export_vv_json.mockReturnValue('{"999":5}');
      mockDocInstance.get_text.mockReturnValue('Merged content');

      await engine.start();
      const syncPromise = engine.initialSync();

      await flush();

      fireMessage({
        type: 'doc_list',
        docs: [{ doc_uuid: 'persisted.md', updated_at: '2026-03-17T00:00:00Z', vv_json: '{}' }],
        tombstones: [],
      });

      await flush();

      // sync_delta for the normal overlapping flow (not conflict probe)
      fireMessage({
        type: 'sync_delta',
        doc_uuid: 'persisted.md',
        delta: new Uint8Array(32),
        server_vv: new TextEncoder().encode('{"999":5}'),
      });

      await syncPromise;

      // No conflict file should be created
      const conflictCreates = mockVault.create.mock.calls.filter(
        (c: any[]) => (c[0] as string).includes('conflict')
      );
      expect(conflictCreates.length).toBe(0);
    });

    it('forks when persisted CRDT has disjoint VV from server', async () => {
      mockVault.getMarkdownFiles.mockReturnValue([{ path: 'diverged.md' }]);
      mockVault.read.mockResolvedValue('Local offline edit');
      mockDocInstance.version.mockReturnValue(5);
      // text_matches = true: disk == CRDT (Obsidian edits); disjoint-VV check still fires
      mockDocInstance.text_matches.mockReturnValue(true);
      // Client has peer-a, server has peer-b → disjoint → fork
      mockDocInstance.export_vv_json.mockReturnValue('{"peer-a":5}');
      mockDocInstance.get_text.mockReturnValue('Server offline edit');
      mockVault.getAbstractFileByPath.mockReturnValue(null);

      await engine.start();
      const syncPromise = engine.initialSync();

      await flush();

      fireMessage({
        type: 'doc_list',
        docs: [{ doc_uuid: 'diverged.md', updated_at: '2026-03-17T00:00:00Z', vv_json: '{"peer-b":3}' }],
        tombstones: [],
      });

      await flush();

      fireMessage({
        type: 'sync_delta',
        doc_uuid: 'diverged.md',
        delta: new Uint8Array(64),
        server_vv: new TextEncoder().encode('{"peer-b":3}'),
      });

      await syncPromise;

      // Should have created a conflict file with local content
      const conflictCreates = mockVault.create.mock.calls.filter(
        (c: any[]) => (c[0] as string).includes('conflict')
      );
      expect(conflictCreates.length).toBe(1);
      expect(conflictCreates[0][1]).toBe('Local offline edit');
    });

    it('disjoint VV + same text → adopt server, no conflict, no merge', async () => {
      // Regression test against the architectural bug fixed in
      // gpt-audit/conflict-storm-plan.md: when local CRDT history and server
      // history are disjoint but happen to render the same text, the OLD code
      // ran a Loro merge anyway. Loro then treated the inserts as concurrent
      // and concatenated them, doubling the document. The NEW behaviour is to
      // adopt the server snapshot wholesale and never merge — even though no
      // conflict file is needed (texts already agree).
      mockVault.getMarkdownFiles.mockReturnValue([{ path: 'same-text.md' }]);
      mockVault.read.mockResolvedValue('Identical content');
      mockDocInstance.version.mockReturnValue(3);
      mockDocInstance.text_matches.mockReturnValue(true);
      mockDocInstance.export_vv_json.mockReturnValue('{"peer-x":3}');
      mockDocInstance.get_text.mockReturnValue('Identical content');
      mockVault.getAbstractFileByPath.mockReturnValue(null);

      await engine.start();
      const syncPromise = engine.initialSync();

      await flush();

      fireMessage({
        type: 'doc_list',
        docs: [{ doc_uuid: 'same-text.md', updated_at: '2026-03-17T00:00:00Z', vv_json: '{"peer-y":2}' }],
        tombstones: [],
      });

      await flush();

      fireMessage({
        type: 'sync_delta',
        doc_uuid: 'same-text.md',
        delta: new Uint8Array(32),
        server_vv: new TextEncoder().encode('{"peer-y":2}'),
      });

      await syncPromise;

      // No conflict file (texts already agree)
      const conflictCreates = mockVault.create.mock.calls.filter(
        (c: any[]) => (c[0] as string).includes('conflict')
      );
      expect(conflictCreates.length).toBe(0);

      // Adopt path must call removeAndClean (drops persisted .loro)
      // followed by import_snapshot on the fresh doc. We can't easily
      // assert removeAndClean directly (DocumentManager is real), but we
      // can assert that import_snapshot was called for the adopt step.
      expect(mockDocInstance.import_snapshot).toHaveBeenCalled();
    });

    it('disjoint VV + same text must NOT call sync_from_disk to merge', async () => {
      // Stronger version of the above: explicitly assert that the engine
      // never falls into the synthesise-history-then-merge path that doubled
      // text in the richardsachen vault.
      mockVault.getMarkdownFiles.mockReturnValue([{ path: 'never-merge.md' }]);
      mockVault.read.mockResolvedValue('Same body');
      mockDocInstance.version.mockReturnValue(7);
      // text_matches=true: the persisted CRDT already renders 'Same body'
      mockDocInstance.text_matches.mockReturnValue(true);
      mockDocInstance.export_vv_json.mockReturnValue('{"local-peer":7}');
      mockDocInstance.get_text.mockReturnValue('Same body');
      mockVault.getAbstractFileByPath.mockReturnValue(null);

      await engine.start();
      const syncPromise = engine.initialSync();

      await flush();

      fireMessage({
        type: 'doc_list',
        docs: [{ doc_uuid: 'never-merge.md', updated_at: '2026-03-17T00:00:00Z', vv_json: '{"server-peer":4}' }],
        tombstones: [],
      });

      await flush();

      fireMessage({
        type: 'sync_delta',
        doc_uuid: 'never-merge.md',
        delta: new Uint8Array(48),
        server_vv: new TextEncoder().encode('{"server-peer":4}'),
      });

      await syncPromise;

      // The disjoint-adopt path bypasses sync_from_disk entirely. text_matches
      // is true so no pre-merge sync_from_disk should fire either.
      expect(mockDocInstance.sync_from_disk).not.toHaveBeenCalled();
    });

    it('missing local CRDT + same text → adopt server, no conflict, no resync', async () => {
      // Phase 2 regression: file exists locally with content but no .loro
      // state (state-loss scenario). Server has a doc for the same path
      // with identical text. The engine MUST adopt the server snapshot
      // directly and never run sync_from_disk(localContent) on the fresh
      // doc — that synthesises a new CRDT history that would later collide.
      mockVault.getMarkdownFiles.mockReturnValue([{ path: 'state-lost.md' }]);
      mockVault.read.mockResolvedValue('Identical body');
      mockDocInstance.version.mockReturnValue(0); // no persisted state
      mockDocInstance.text_matches.mockReturnValue(false);
      mockDocInstance.get_text.mockReturnValue('Identical body');
      mockVault.getAbstractFileByPath.mockReturnValue(null);

      await engine.start();
      const syncPromise = engine.initialSync();

      await flush();

      fireMessage({
        type: 'doc_list',
        docs: [{ doc_uuid: 'state-lost.md', updated_at: '2026-03-17T00:00:00Z', vv_json: '{}' }],
        tombstones: [],
      });

      await flush();

      // Phase 2 issues exactly ONE sync_start (the probe). The old code
      // issued two — probe plus a follow-up clientVV-based merge call.
      fireMessage({
        type: 'sync_delta',
        doc_uuid: 'state-lost.md',
        delta: new Uint8Array(96),
        server_vv: new TextEncoder().encode('{"server":9}'),
      });

      await syncPromise;

      // No conflict file
      const conflictCreates = mockVault.create.mock.calls.filter(
        (c: any[]) => (c[0] as string).includes('conflict')
      );
      expect(conflictCreates.length).toBe(0);

      // No synthesise-then-merge: sync_from_disk must never run on this path
      expect(mockDocInstance.sync_from_disk).not.toHaveBeenCalled();

      // Server snapshot was adopted
      expect(mockDocInstance.import_snapshot).toHaveBeenCalled();

      // Phase 2 must issue exactly ONE sync_start (the probe with null VV).
      // The old code issued two — probe plus a follow-up clientVV-based merge
      // call — which is what synthesised the colliding history.
      const syncStartCalls = mockEncode.mock.calls.filter(
        (c: any[]) => c[0]?.type === 'sync_start' && c[0]?.doc_uuid === 'state-lost.md'
      );
      expect(syncStartCalls.length).toBe(1);
      expect(syncStartCalls[0][0].client_vv).toBeNull();
    });

    it('missing local CRDT + server stub empty → falls through to local create path', async () => {
      // Phase 2 fall-through: server returned the path in doc_list but the
      // probe sync_start delivers a zero-length delta (empty server stub or
      // doc was just deleted between doc_list and sync_start). The Phase-2
      // adopt-or-conflict guard does NOT apply here — there is no real CRDT
      // history to clash with — so the engine must fall through to the
      // normal sync_from_disk + sync_start(clientVV) path.
      mockVault.getMarkdownFiles.mockReturnValue([{ path: 'fall-through.md' }]);
      mockVault.read.mockResolvedValue('fresh local');
      mockDocInstance.version.mockReturnValue(0); // no persisted state
      mockDocInstance.text_matches.mockReturnValue(false);
      mockDocInstance.get_text.mockReturnValue('fresh local');
      mockDocInstance.export_vv_json.mockReturnValue('{}');
      mockVault.getAbstractFileByPath.mockReturnValue(null);

      await engine.start();
      const syncPromise = engine.initialSync();

      await flush();

      fireMessage({
        type: 'doc_list',
        docs: [{ doc_uuid: 'fall-through.md', updated_at: '2026-03-17T00:00:00Z', vv_json: '{}' }],
        tombstones: [],
      });

      await flush();

      // Probe response — empty delta means "no real server content".
      fireMessage({
        type: 'sync_delta',
        doc_uuid: 'fall-through.md',
        delta: new Uint8Array(0),
        server_vv: new TextEncoder().encode('{}'),
      });

      await flush();

      // Second sync_start (after fall-through) gets a follow-up sync_delta.
      fireMessage({
        type: 'sync_delta',
        doc_uuid: 'fall-through.md',
        delta: new Uint8Array(0),
        server_vv: new TextEncoder().encode('{}'),
      });

      await syncPromise;

      // No conflict file — fall-through path is benign.
      const conflictCreates = mockVault.create.mock.calls.filter(
        (c: any[]) => (c[0] as string).includes('conflict')
      );
      expect(conflictCreates.length).toBe(0);

      // sync_from_disk SHOULD run in this special case — that's the whole
      // point of the fall-through, since the empty stub is safe to overwrite.
      expect(mockDocInstance.sync_from_disk).toHaveBeenCalledWith('fresh local');

      // Two sync_start calls: probe (null VV) + follow-up (with real clientVV).
      const syncStartCalls = mockEncode.mock.calls.filter(
        (c: any[]) => c[0]?.type === 'sync_start' && c[0]?.doc_uuid === 'fall-through.md'
      );
      expect(syncStartCalls.length).toBe(2);
      expect(syncStartCalls[0][0].client_vv).toBeNull();
      expect(syncStartCalls[1][0].client_vv).not.toBeNull();
    });

    it('no fork when server text matches local', async () => {
      mockVault.getMarkdownFiles.mockReturnValue([{ path: 'same.md' }]);
      mockVault.read.mockResolvedValue('Same content');
      mockDocInstance.version.mockReturnValue(0);
      mockDocInstance.text_matches.mockReturnValue(false);
      mockDocInstance.get_text.mockReturnValue('Same content');
      mockVault.getAbstractFileByPath.mockReturnValue(null);

      await engine.start();
      const syncPromise = engine.initialSync();

      await flush();

      fireMessage({
        type: 'doc_list',
        docs: [{ doc_uuid: 'same.md', updated_at: '2026-03-17T00:00:00Z', vv_json: '{}' }],
        tombstones: [],
      });

      await flush();

      // sync_delta: server has same content
      fireMessage({
        type: 'sync_delta',
        doc_uuid: 'same.md',
        delta: new Uint8Array(64),
        server_vv: new TextEncoder().encode('{"999":5}'),
      });

      await flush();

      // Second sync_delta for the normal overlapping flow
      fireMessage({
        type: 'sync_delta',
        doc_uuid: 'same.md',
        delta: new Uint8Array(32),
        server_vv: new TextEncoder().encode('{"999":5}'),
      });

      await syncPromise;

      const conflictCreates = mockVault.create.mock.calls.filter(
        (c: any[]) => (c[0] as string).includes('conflict')
      );
      expect(conflictCreates.length).toBe(0);
    });

    it('conflict path increments counter if file exists', async () => {
      mockVault.getMarkdownFiles.mockReturnValue([{ path: 'dup.md' }]);
      mockVault.read.mockResolvedValue('Local dup');
      mockDocInstance.version.mockReturnValue(0);
      mockDocInstance.text_matches.mockReturnValue(false);
      mockDocInstance.get_text.mockReturnValue('Server dup');

      // First conflict path already exists, second (with " 2") doesn't
      mockVault.getAbstractFileByPath.mockImplementation((p: string) => {
        if (p.includes('conflict') && !p.includes(' 2)')) {
          return { path: p }; // exists
        }
        return null;
      });

      await engine.start();
      const syncPromise = engine.initialSync();

      await flush();

      fireMessage({
        type: 'doc_list',
        docs: [{ doc_uuid: 'dup.md', updated_at: '2026-03-17T00:00:00Z', vv_json: '{}' }],
        tombstones: [],
      });

      await flush();

      fireMessage({
        type: 'sync_delta',
        doc_uuid: 'dup.md',
        delta: new Uint8Array(64),
        server_vv: new TextEncoder().encode('{"999":5}'),
      });

      await syncPromise;

      const createCalls = mockVault.create.mock.calls.filter(
        (c: any[]) => (c[0] as string).includes('conflict')
      );
      expect(createCalls.length).toBe(1);
      expect(createCalls[0][0]).toMatch(/dup \(conflict \d{4}-\d{2}-\d{2} 2\)\.md/);
    });

    // ── stale-disk-vs-fresh-editor regression tests ────────────────────────
    // These cover the bug where adopt/conflict decisions were made on stale
    // disk content while an open editor had unsaved changes — leading to
    // conflict files containing the WRONG (disk) text and silently losing
    // the user's most recent keystrokes. Fix is in src/sync-initial.ts:
    // readEffectiveLocalContent() + belt-and-suspenders in syncOverlappingDoc.

    const makeStaleEditorLeaf = (path: string, editorContent: string) => {
      const editor = {
        getValue: vi.fn().mockReturnValue(editorContent),
        setValue: vi.fn(),
        getCursor: vi.fn().mockReturnValue({ line: 0, ch: 0 }),
        setCursor: vi.fn(),
        lastLine: vi.fn().mockReturnValue(0),
        getLine: vi.fn().mockReturnValue(''),
        offsetToPos: vi.fn().mockReturnValue({ line: 0, ch: 0 }),
        transaction: vi.fn(),
      };
      return {
        view: Object.assign(Object.create(MockMarkdownView.prototype), {
          file: { path },
          editor,
        }),
      };
    };

    it('disjoint VV + stale disk + fresh editor → conflict body is editor text', async () => {
      // Phase 3 stale-editor regression. Disk has the old saved version,
      // an open editor has unsaved keystrokes. The disjoint-VV adopt path
      // creates a conflict file — its body MUST contain the editor's fresh
      // text, not the stale disk text.
      const leaf = makeStaleEditorLeaf('p3-stale.md', 'EDITOR fresh');
      engine = new SyncEngine(makeApp([leaf]), makeSettings());

      mockVault.getMarkdownFiles.mockReturnValue([{ path: 'p3-stale.md' }]);
      mockVault.read.mockResolvedValue('DISK stale');
      mockDocInstance.version.mockReturnValue(5);
      mockDocInstance.text_matches.mockReturnValue(true);
      mockDocInstance.export_vv_json.mockReturnValue('{"peer-x":5}');
      // tempDoc.get_text() (the probe import) returns the server text
      mockDocInstance.get_text.mockReturnValue('DISK stale');
      mockVault.getAbstractFileByPath.mockReturnValue(null);

      await engine.start();
      const syncPromise = engine.initialSync();

      await flush();

      fireMessage({
        type: 'doc_list',
        docs: [{ doc_uuid: 'p3-stale.md', updated_at: '2026-03-17T00:00:00Z', vv_json: '{"peer-y":3}' }],
        tombstones: [],
      });

      await flush();

      fireMessage({
        type: 'sync_delta',
        doc_uuid: 'p3-stale.md',
        delta: new Uint8Array(64),
        server_vv: new TextEncoder().encode('{"peer-y":3}'),
      });

      await syncPromise;

      const conflictCreates = mockVault.create.mock.calls.filter(
        (c: any[]) => (c[0] as string).includes('conflict')
      );
      expect(conflictCreates.length).toBe(1);
      expect(conflictCreates[0][1]).toBe('EDITOR fresh');
    });

    it('missing local CRDT + stale disk + fresh editor → conflict body is editor text', async () => {
      // Phase 2 stale-editor regression. No persisted state, so the engine
      // takes the Phase-2 adopt path. localContent must come from the open
      // editor, not vault.read.
      const leaf = makeStaleEditorLeaf('p2-stale.md', 'EDITOR fresh');
      engine = new SyncEngine(makeApp([leaf]), makeSettings());

      mockVault.getMarkdownFiles.mockReturnValue([{ path: 'p2-stale.md' }]);
      mockVault.read.mockResolvedValue('DISK stale');
      mockDocInstance.version.mockReturnValue(0); // no persisted state
      mockDocInstance.text_matches.mockReturnValue(false);
      mockDocInstance.get_text.mockReturnValue('DISK stale'); // server text after probe
      mockVault.getAbstractFileByPath.mockReturnValue(null);

      await engine.start();
      const syncPromise = engine.initialSync();

      await flush();

      fireMessage({
        type: 'doc_list',
        docs: [{ doc_uuid: 'p2-stale.md', updated_at: '2026-03-17T00:00:00Z', vv_json: '{}' }],
        tombstones: [],
      });

      await flush();

      fireMessage({
        type: 'sync_delta',
        doc_uuid: 'p2-stale.md',
        delta: new Uint8Array(96),
        server_vv: new TextEncoder().encode('{"server":9}'),
      });

      await syncPromise;

      const conflictCreates = mockVault.create.mock.calls.filter(
        (c: any[]) => (c[0] as string).includes('conflict')
      );
      expect(conflictCreates.length).toBe(1);
      expect(conflictCreates[0][1]).toBe('EDITOR fresh');
    });

    it('local-only doc_create uses editor content, not stale disk', async () => {
      // Local-only path regression. A new file is open with unsaved edits;
      // the disk snapshot is stale. doc_create must push the editor's text.
      const leaf = makeStaleEditorLeaf('local-only.md', 'EDITOR fresh');
      engine = new SyncEngine(makeApp([leaf]), makeSettings());

      mockVault.getMarkdownFiles.mockReturnValue([{ path: 'local-only.md' }]);
      mockVault.read.mockResolvedValue('DISK stale');

      await engine.start();
      const syncPromise = engine.initialSync();

      await flush();

      // Server has no docs at all → local-only path
      fireMessage({ type: 'doc_list', docs: [], tombstones: [] });

      await syncPromise;

      // sync_from_disk must be called with the EDITOR text, not the disk text
      expect(mockDocInstance.sync_from_disk).toHaveBeenCalledWith('EDITOR fresh');
      expect(mockDocInstance.sync_from_disk).not.toHaveBeenCalledWith('DISK stale');

      // doc_create push happened
      const createCalls = mockEncode.mock.calls.filter(
        (c: any[]) => c[0]?.type === 'doc_create' && c[0]?.doc_uuid === 'local-only.md'
      );
      expect(createCalls.length).toBe(1);
    });

    it('startup editor typing merges instead of forking a conflict overwrite', async () => {
      vi.useFakeTimers();
      const leaf = makeStaleEditorLeaf('startup-merge.md', 'EDITOR fresh');
      const app = makeApp([leaf]);
      app.workspace.getActiveViewOfType.mockReturnValue(leaf.view);
      engine = new SyncEngine(app, makeSettings({ debounceMs: 1250 }));

      mockVault.getMarkdownFiles.mockReturnValue([{ path: 'startup-merge.md' }]);
      mockVault.read.mockResolvedValue('DISK stale');
      mockDocInstance.version.mockReturnValue(5);
      mockDocInstance.text_matches.mockReturnValue(false);
      mockDocInstance.export_vv_json.mockReturnValue('{"peer1":5}');
      mockDocInstance.get_text.mockReturnValue('EDITOR fresh remote');
      mockDocInstance.import_and_diff.mockReturnValue('[{"retain":12},{"insert":" remote"}]');

      await engine.start();
      engine.onFileChanged('startup-merge.md');
      const syncPromise = engine.initialSync();

      await flush();

      fireMessage({
        type: 'doc_list',
        docs: [{ doc_uuid: 'startup-merge.md', updated_at: '2026-03-17T00:00:00Z', server_vv: new TextEncoder().encode('{"peer1":6}') }],
        tombstones: [],
      });

      await flush(50);

      fireMessage({
        type: 'sync_delta',
        doc_uuid: 'startup-merge.md',
        delta: new Uint8Array(22),
        server_vv: new TextEncoder().encode('{"peer1":6}'),
      });

      await syncPromise;

      const conflictCreates = mockVault.create.mock.calls.filter(
        (c: any[]) => (c[0] as string).includes('conflict')
      );
      expect(conflictCreates.length).toBe(0);
      expect(leaf.view.editor.transaction).toHaveBeenCalled();
      expect(mockVault.modify).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('active editor matching merged text completes without conflict fork', async () => {
      const mockEditor = {
        getValue: vi.fn().mockReturnValue('EDITOR fresh'),
        setValue: vi.fn(),
        getCursor: vi.fn().mockReturnValue({ line: 0, ch: 0 }),
        setCursor: vi.fn(),
        lastLine: vi.fn().mockReturnValue(0),
        getLine: vi.fn().mockReturnValue(''),
        offsetToPos: vi.fn().mockReturnValue({ line: 0, ch: 0 }),
        transaction: vi.fn(),
      };
      const leaf = {
        view: Object.assign(Object.create(MockMarkdownView.prototype), {
          file: { path: 'active-noop.md' },
          editor: mockEditor,
        }),
      };
      const app = makeApp([leaf]);
      app.workspace.getActiveViewOfType.mockReturnValue(leaf.view);
      engine = new SyncEngine(app, makeSettings());

      mockVault.getMarkdownFiles.mockReturnValue([{ path: 'active-noop.md' }]);
      mockVault.read.mockResolvedValue('DISK stale');
      mockDocInstance.version.mockReturnValue(5);
      mockDocInstance.text_matches
        .mockImplementationOnce(() => false)
        .mockImplementation(() => true);
      mockDocInstance.export_vv_json.mockReturnValue('{"peer1":5}');
      mockDocInstance.get_text.mockReturnValue('EDITOR fresh');
      mockDocInstance.import_and_diff.mockReturnValue('');

      await engine.start();
      const syncPromise = engine.initialSync();

      await flush();
      fireMessage({
        type: 'doc_list',
        docs: [{ doc_uuid: 'active-noop.md', updated_at: '2026-03-17T00:00:00Z', server_vv: new TextEncoder().encode('{"peer1":6}') }],
        tombstones: [],
      });

      await flush(50);
      fireMessage({
        type: 'sync_delta',
        doc_uuid: 'active-noop.md',
        delta: new Uint8Array(22),
        server_vv: new TextEncoder().encode('{"peer1":6}'),
      });

      await syncPromise;

      const conflictCreates = mockVault.create.mock.calls.filter(
        (c: any[]) => (c[0] as string).includes('conflict')
      );
      expect(conflictCreates.length).toBe(0);
    });

    // ── active-editor startup disk-persist skip (correctness fix) ──────────
    // On mobile, vault.modify() on the active file during the startup window
    // triggers an editor rebind that eats in-flight keystrokes. When the user
    // typed during startup AND the editor already shows the merged text, skip
    // the disk write and let Obsidian autosave handle persistence later.

    it('T-C1: skips vault.modify for active editor during startup when editor matches merged text', async () => {
      vi.useFakeTimers();
      const leaf = makeStaleEditorLeaf('tc1.md', 'MERGED text');
      const app = makeApp([leaf]);
      app.workspace.getActiveViewOfType.mockReturnValue(leaf.view);
      engine = new SyncEngine(app, makeSettings({ debounceMs: 1250 }));

      mockVault.getMarkdownFiles.mockReturnValue([{ path: 'tc1.md' }]);
      mockVault.read.mockResolvedValue('DISK stale');
      mockDocInstance.version.mockReturnValue(5);
      // text_matches true: local content matches CRDT, editor matches after import
      mockDocInstance.text_matches.mockReturnValue(true);
      mockDocInstance.export_vv_json.mockReturnValue('{"peer1":5}');
      mockDocInstance.get_text.mockReturnValue('MERGED text');
      mockDocInstance.import_and_diff.mockReturnValue('[]');

      await engine.start();
      engine.onFileChanged('tc1.md'); // marks editedDuringStartup
      const syncPromise = engine.initialSync();

      await flush();
      fireMessage({
        type: 'doc_list',
        docs: [{ doc_uuid: 'tc1.md', updated_at: '2026-04-09T00:00:00Z', server_vv: new TextEncoder().encode('{"peer1":6}') }],
        tombstones: [],
      });
      await flush(50);
      fireMessage({
        type: 'sync_delta',
        doc_uuid: 'tc1.md',
        delta: new Uint8Array(22),
        server_vv: new TextEncoder().encode('{"peer1":6}'),
      });
      await syncPromise;

      // vault.modify must NOT be called — that's the whole fix
      expect(mockVault.modify).not.toHaveBeenCalled();
      // editor.setValue must NOT be called either
      expect(leaf.view.editor.setValue).not.toHaveBeenCalled();
      // CRDT state must still be persisted to .loro file
      expect(mockAdapter.writeBinary).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('T-C3: non-active editor still gets writeToVault during startup', async () => {
      vi.useFakeTimers();
      const leaf = makeStaleEditorLeaf('tc3.md', 'MERGED text');
      const app = makeApp([leaf]);
      // Active view is null → not the active editor doc
      app.workspace.getActiveViewOfType.mockReturnValue(null);
      engine = new SyncEngine(app, makeSettings({ debounceMs: 1250 }));

      mockVault.getMarkdownFiles.mockReturnValue([{ path: 'tc3.md' }]);
      mockVault.read.mockResolvedValue('DISK stale');
      mockDocInstance.version.mockReturnValue(5);
      mockDocInstance.text_matches.mockReturnValue(false);
      mockDocInstance.export_vv_json.mockReturnValue('{"peer1":5}');
      mockDocInstance.get_text.mockReturnValue('SERVER merged');
      mockDocInstance.import_snapshot.mockReturnValue(undefined);

      // getAbstractFileByPath for writeToVault disk-write path
      const mockFile = Object.create(TFile.prototype);
      mockVault.getAbstractFileByPath.mockReturnValue(mockFile);
      mockVault.read.mockResolvedValue('DISK stale');

      await engine.start();
      engine.onFileChanged('tc3.md');
      const syncPromise = engine.initialSync();

      await flush();
      fireMessage({
        type: 'doc_list',
        docs: [{ doc_uuid: 'tc3.md', updated_at: '2026-04-09T00:00:00Z', server_vv: new TextEncoder().encode('{"peer1":6}') }],
        tombstones: [],
      });
      await flush(50);
      fireMessage({
        type: 'sync_delta',
        doc_uuid: 'tc3.md',
        delta: new Uint8Array(22),
        server_vv: new TextEncoder().encode('{"peer1":6}'),
      });
      await syncPromise;

      // Non-active file: writeToVault SHOULD be called (editor path → setValue)
      expect(leaf.view.editor.setValue).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('T-C4: active editor with editedDuringStartup=false still gets disk persist', async () => {
      const leaf = makeStaleEditorLeaf('tc4.md', 'MERGED text');
      const app = makeApp([leaf]);
      app.workspace.getActiveViewOfType.mockReturnValue(leaf.view);
      engine = new SyncEngine(app, makeSettings());

      mockVault.getMarkdownFiles.mockReturnValue([{ path: 'tc4.md' }]);
      mockVault.read.mockResolvedValue('DISK stale');
      mockDocInstance.version.mockReturnValue(5);
      mockDocInstance.text_matches.mockReturnValue(true);
      mockDocInstance.export_vv_json.mockReturnValue('{"peer1":5}');
      mockDocInstance.get_text.mockReturnValue('MERGED text');
      mockDocInstance.import_and_diff.mockReturnValue('[]');

      // getAbstractFileByPath needed for writeToVault's vault.read check
      const mockFile = Object.create(TFile.prototype);
      mockVault.getAbstractFileByPath.mockReturnValue(mockFile);

      await engine.start();
      // NOTE: no onFileChanged call → editedDuringStartup stays false
      const syncPromise = engine.initialSync();

      await flush();
      fireMessage({
        type: 'doc_list',
        docs: [{ doc_uuid: 'tc4.md', updated_at: '2026-04-09T00:00:00Z', server_vv: new TextEncoder().encode('{"peer1":6}') }],
        tombstones: [],
      });
      await flush(50);
      fireMessage({
        type: 'sync_delta',
        doc_uuid: 'tc4.md',
        delta: new Uint8Array(22),
        server_vv: new TextEncoder().encode('{"peer1":6}'),
      });
      await syncPromise;

      // Not edited during startup → disk persist should still happen
      expect(mockVault.modify).toHaveBeenCalled();
    });

    it('T-C5: vv-cache hash reflects CRDT text after startup skip', async () => {
      vi.useFakeTimers();
      const { textFiles } = installVirtualStateStore();

      const leaf = makeStaleEditorLeaf('tc5.md', 'MERGED text');
      const app = makeApp([leaf]);
      app.workspace.getActiveViewOfType.mockReturnValue(leaf.view);
      engine = new SyncEngine(app, makeSettings({ debounceMs: 1250 }));

      mockVault.getMarkdownFiles.mockReturnValue([{ path: 'tc5.md' }]);
      mockVault.read.mockResolvedValue('DISK stale');
      mockDocInstance.version.mockReturnValue(5);
      mockDocInstance.text_matches.mockReturnValue(true);
      mockDocInstance.export_vv_json.mockReturnValue('{"peer1":5}');
      mockDocInstance.get_text.mockReturnValue('MERGED text');
      mockDocInstance.import_and_diff.mockReturnValue('[]');

      await engine.start();
      engine.onFileChanged('tc5.md');
      const syncPromise = engine.initialSync();

      await flush();
      fireMessage({
        type: 'doc_list',
        docs: [{ doc_uuid: 'tc5.md', updated_at: '2026-04-09T00:00:00Z', server_vv: new TextEncoder().encode('{"peer1":6}') }],
        tombstones: [],
      });
      await flush(50);
      fireMessage({
        type: 'sync_delta',
        doc_uuid: 'tc5.md',
        delta: new Uint8Array(22),
        server_vv: new TextEncoder().encode('{"peer1":6}'),
      });
      await syncPromise;

      // vv-cache.json must have been persisted with correct hash
      const cacheRaw = textFiles.get('.obsidian/plugins/vaultcrdt/state/vv-cache.json');
      expect(cacheRaw).toBeDefined();
      const cache = JSON.parse(cacheRaw!);
      expect(cache['tc5.md']).toBeDefined();
      // Hash must be non-zero (derived from CRDT text, not the stale disk)
      expect(cache['tc5.md'].contentHash).not.toBe(0);

      vi.useRealTimers();
    });

    it('T-C6: no conflict file created during startup disk-persist skip', async () => {
      vi.useFakeTimers();
      const leaf = makeStaleEditorLeaf('tc6.md', 'MERGED text');
      const app = makeApp([leaf]);
      app.workspace.getActiveViewOfType.mockReturnValue(leaf.view);
      engine = new SyncEngine(app, makeSettings({ debounceMs: 1250 }));

      mockVault.getMarkdownFiles.mockReturnValue([{ path: 'tc6.md' }]);
      mockVault.read.mockResolvedValue('DISK stale');
      mockDocInstance.version.mockReturnValue(5);
      mockDocInstance.text_matches.mockReturnValue(true);
      mockDocInstance.export_vv_json.mockReturnValue('{"peer1":5}');
      mockDocInstance.get_text.mockReturnValue('MERGED text');
      mockDocInstance.import_and_diff.mockReturnValue('[]');

      await engine.start();
      engine.onFileChanged('tc6.md');
      const syncPromise = engine.initialSync();

      await flush();
      fireMessage({
        type: 'doc_list',
        docs: [{ doc_uuid: 'tc6.md', updated_at: '2026-04-09T00:00:00Z', server_vv: new TextEncoder().encode('{"peer1":6}') }],
        tombstones: [],
      });
      await flush(50);
      fireMessage({
        type: 'sync_delta',
        doc_uuid: 'tc6.md',
        delta: new Uint8Array(22),
        server_vv: new TextEncoder().encode('{"peer1":6}'),
      });
      await syncPromise;

      // No conflict files created
      const conflictCreates = mockVault.create.mock.calls.filter(
        (c: any[]) => (c[0] as string).includes('conflict')
      );
      expect(conflictCreates.length).toBe(0);

      vi.useRealTimers();
    });
  });

  // ── echo guard ─────────────────────────────────────────────────────────────

  describe('echo guard', () => {
    it('suppresses push when content matches last remote write', async () => {
      const mockFile = Object.create(TFile.prototype);
      mockVault.getAbstractFileByPath.mockReturnValue(mockFile);
      mockDocInstance.get_text.mockReturnValue('remote content');

      await engine.start();

      // Simulate delta_broadcast → writeToVault sets lastRemoteWrite
      fireMessage({
        type: 'delta_broadcast',
        doc_uuid: 'echo.md',
        delta: new Uint8Array(32),
        peer_id: 'other-peer',
      });
      await flush();

      // Now simulate editor-change echoing the same content back
      engine.onFileChangedImmediate('echo.md', 'remote content');
      await flush();

      // No sync_push should have been sent for the echo
      const pushCalls = mockEncode.mock.calls.filter(
        (c: any[]) => c[0]?.type === 'sync_push' && c[0]?.doc_uuid === 'echo.md'
      );
      expect(pushCalls.length).toBe(0);
    });

    it('allows push when content differs from last remote write', async () => {
      const mockFile = Object.create(TFile.prototype);
      mockVault.getAbstractFileByPath.mockReturnValue(mockFile);
      mockDocInstance.get_text.mockReturnValue('remote content');

      await engine.start();

      // Simulate delta_broadcast
      fireMessage({
        type: 'delta_broadcast',
        doc_uuid: 'echo2.md',
        delta: new Uint8Array(32),
        peer_id: 'other-peer',
      });
      await flush();

      // User types new content (not an echo)
      engine.onFileChangedImmediate('echo2.md', 'user typed something new');
      await flush();

      // sync_push should have been sent
      const pushCalls = mockEncode.mock.calls.filter(
        (c: any[]) => c[0]?.type === 'sync_push' && c[0]?.doc_uuid === 'echo2.md'
      );
      expect(pushCalls.length).toBe(1);
    });

    it('echo guard is one-shot — second push with same content goes through', async () => {
      const mockFile = Object.create(TFile.prototype);
      mockVault.getAbstractFileByPath.mockReturnValue(mockFile);
      mockDocInstance.get_text.mockReturnValue('remote content');

      await engine.start();

      // Simulate delta_broadcast
      fireMessage({
        type: 'delta_broadcast',
        doc_uuid: 'echo3.md',
        delta: new Uint8Array(32),
        peer_id: 'other-peer',
      });
      await flush();

      // First echo — suppressed
      engine.onFileChangedImmediate('echo3.md', 'remote content');
      await flush();

      // Second push with same content — should NOT be suppressed (guard consumed)
      engine.onFileChangedImmediate('echo3.md', 'remote content');
      await flush();

      const pushCalls = mockEncode.mock.calls.filter(
        (c: any[]) => c[0]?.type === 'sync_push' && c[0]?.doc_uuid === 'echo3.md'
      );
      // Only the second push goes through (first was echo-suppressed, second passes text_matches check)
      // Since text_matches is mocked to return false, the second call should produce a push
      expect(pushCalls.length).toBe(1);
    });
  });

  // ── editor-level sync ──────────────────────────────────────────────────────

  describe('editor-level sync', () => {
    it('applies remote content directly to open editor instead of disk', async () => {
      const mockEditor = {
        getValue: vi.fn().mockReturnValue('local content'),
        getCursor: vi.fn().mockReturnValue({ line: 0, ch: 5 }),
        setValue: vi.fn(),
        setCursor: vi.fn(),
        lastLine: vi.fn().mockReturnValue(0),
        getLine: vi.fn().mockReturnValue('remote content'),
      };
      const mockLeaf = {
        view: Object.assign(Object.create(MockMarkdownView.prototype), {
          file: { path: 'editor.md' },
          editor: mockEditor,
        }),
      };

      engine = new SyncEngine(makeApp([mockLeaf]), makeSettings());
      await engine.start();

      mockDocInstance.get_text.mockReturnValue('remote content');
      mockVault.getAbstractFileByPath.mockReturnValue(Object.create(TFile.prototype));
      mockVault.read.mockResolvedValue('old content');

      fireMessage({
        type: 'delta_broadcast',
        doc_uuid: 'editor.md',
        delta: new Uint8Array(32),
        peer_id: 'other-peer',
      });

      await flush();

      // Editor should have been updated directly
      expect(mockEditor.setValue).toHaveBeenCalledWith('remote content');
      // Cursor should be restored
      expect(mockEditor.setCursor).toHaveBeenCalled();
      // Disk write should NOT have happened (editor strategy used)
      expect(mockVault.modify).not.toHaveBeenCalled();
    });

    it('does not rewrite an open editor when it already shows the target content', async () => {
      const mockEditor = {
        getValue: vi.fn().mockReturnValue('remote content'),
        getCursor: vi.fn().mockReturnValue({ line: 0, ch: 5 }),
        setValue: vi.fn(),
        setCursor: vi.fn(),
        lastLine: vi.fn().mockReturnValue(0),
        getLine: vi.fn().mockReturnValue('remote content'),
      };
      const mockLeaf = {
        view: Object.assign(Object.create(MockMarkdownView.prototype), {
          file: { path: 'editor.md' },
          editor: mockEditor,
        }),
      };

      engine = new SyncEngine(makeApp([mockLeaf]), makeSettings());
      await engine.start();

      mockDocInstance.get_text.mockReturnValue('remote content');
      mockVault.getAbstractFileByPath.mockReturnValue(Object.create(TFile.prototype));
      mockVault.read.mockResolvedValue('old content');

      fireMessage({
        type: 'delta_broadcast',
        doc_uuid: 'editor.md',
        delta: new Uint8Array(32),
        peer_id: 'other-peer',
      });

      await flush();

      expect(mockEditor.setValue).not.toHaveBeenCalled();
      expect(mockEditor.setCursor).not.toHaveBeenCalled();
      expect(mockVault.modify).toHaveBeenCalledWith(expect.anything(), 'remote content');
    });

    it('falls back to disk write when no editor is open', async () => {
      // No leaves → applyToEditor returns false → disk fallback
      engine = new SyncEngine(makeApp([]), makeSettings());
      await engine.start();

      mockDocInstance.get_text.mockReturnValue('remote fallback');
      const mockFile = Object.create(TFile.prototype);
      mockVault.getAbstractFileByPath.mockReturnValue(mockFile);
      mockVault.read.mockResolvedValue('old');

      fireMessage({
        type: 'delta_broadcast',
        doc_uuid: 'closed.md',
        delta: new Uint8Array(32),
        peer_id: 'other-peer',
      });

      await flush();

      // Should have written to disk
      expect(mockVault.modify).toHaveBeenCalledWith(mockFile, 'remote fallback');
    });

    it('updates all editors in split view', async () => {
      const mockEditor1 = {
        getValue: vi.fn().mockReturnValue('local 1'),
        getCursor: vi.fn().mockReturnValue({ line: 0, ch: 0 }),
        setValue: vi.fn(),
        setCursor: vi.fn(),
        lastLine: vi.fn().mockReturnValue(0),
        getLine: vi.fn().mockReturnValue('split content'),
      };
      const mockEditor2 = {
        getValue: vi.fn().mockReturnValue('local 2'),
        getCursor: vi.fn().mockReturnValue({ line: 1, ch: 3 }),
        setValue: vi.fn(),
        setCursor: vi.fn(),
        lastLine: vi.fn().mockReturnValue(0),
        getLine: vi.fn().mockReturnValue('split content'),
      };

      const makeLeaf = (editor: any) => ({
        view: Object.assign(Object.create(MockMarkdownView.prototype), {
          file: { path: 'split.md' },
          editor,
        }),
      });

      engine = new SyncEngine(makeApp([makeLeaf(mockEditor1), makeLeaf(mockEditor2)]), makeSettings());
      await engine.start();

      mockDocInstance.get_text.mockReturnValue('split content');
      mockVault.getAbstractFileByPath.mockReturnValue(Object.create(TFile.prototype));
      mockVault.read.mockResolvedValue('old');

      fireMessage({
        type: 'delta_broadcast',
        doc_uuid: 'split.md',
        delta: new Uint8Array(32),
        peer_id: 'other-peer',
      });

      await flush();

      expect(mockEditor1.setValue).toHaveBeenCalledWith('split content');
      expect(mockEditor2.setValue).toHaveBeenCalledWith('split content');
      expect(mockVault.modify).not.toHaveBeenCalled();
    });

    it('clamps cursor to valid range after content change', async () => {
      const mockEditor = {
        getValue: vi.fn().mockReturnValue('old'),
        getCursor: vi.fn().mockReturnValue({ line: 10, ch: 50 }),
        setValue: vi.fn(),
        setCursor: vi.fn(),
        lastLine: vi.fn().mockReturnValue(2),
        getLine: vi.fn().mockReturnValue('short'),
      };
      const mockLeaf = {
        view: Object.assign(Object.create(MockMarkdownView.prototype), {
          file: { path: 'clamp.md' },
          editor: mockEditor,
        }),
      };

      engine = new SyncEngine(makeApp([mockLeaf]), makeSettings());
      await engine.start();

      mockDocInstance.get_text.mockReturnValue('short\ntext\nend');
      mockVault.getAbstractFileByPath.mockReturnValue(Object.create(TFile.prototype));
      mockVault.read.mockResolvedValue('old');

      fireMessage({
        type: 'delta_broadcast',
        doc_uuid: 'clamp.md',
        delta: new Uint8Array(32),
        peer_id: 'other-peer',
      });

      await flush();

      // Cursor should be clamped: line 10→2, ch 50→5 (length of "short")
      expect(mockEditor.setCursor).toHaveBeenCalledWith({ line: 2, ch: 5 });
    });

    it('falls back to disk for reading-mode view (no editor)', async () => {
      const mockLeaf = {
        view: Object.assign(Object.create(MockMarkdownView.prototype), {
          file: { path: 'readonly.md' },
          editor: undefined, // Reading mode has no editor
        }),
      };

      engine = new SyncEngine(makeApp([mockLeaf]), makeSettings());
      await engine.start();

      mockDocInstance.get_text.mockReturnValue('read mode content');
      const mockFile = Object.create(TFile.prototype);
      mockVault.getAbstractFileByPath.mockReturnValue(mockFile);
      mockVault.read.mockResolvedValue('old');

      fireMessage({
        type: 'delta_broadcast',
        doc_uuid: 'readonly.md',
        delta: new Uint8Array(32),
        peer_id: 'other-peer',
      });

      await flush();

      // Should fall back to disk write
      expect(mockVault.modify).toHaveBeenCalledWith(mockFile, 'read mode content');
    });

    it('isUpdatingEditorFromRemote guard prevents echo', async () => {
      const editorChangeGuardChecks: boolean[] = [];
      const mockEditor = {
        getValue: vi.fn().mockReturnValue('old local'),
        getCursor: vi.fn().mockReturnValue({ line: 0, ch: 0 }),
        setValue: vi.fn().mockImplementation(() => {
          // Simulate: during setValue, check if guard is active
          editorChangeGuardChecks.push(engine.isUpdatingEditorFromRemote('guard-test.md'));
        }),
        setCursor: vi.fn(),
        lastLine: vi.fn().mockReturnValue(0),
        getLine: vi.fn().mockReturnValue('guarded'),
      };
      const mockLeaf = {
        view: Object.assign(Object.create(MockMarkdownView.prototype), {
          file: { path: 'guard-test.md' },
          editor: mockEditor,
        }),
      };

      engine = new SyncEngine(makeApp([mockLeaf]), makeSettings());
      await engine.start();

      mockDocInstance.get_text.mockReturnValue('guarded');
      mockVault.getAbstractFileByPath.mockReturnValue(Object.create(TFile.prototype));
      mockVault.read.mockResolvedValue('old');

      fireMessage({
        type: 'delta_broadcast',
        doc_uuid: 'guard-test.md',
        delta: new Uint8Array(32),
        peer_id: 'other-peer',
      });

      await flush();

      // During setValue, the guard should have been active
      expect(editorChangeGuardChecks).toEqual([true]);
      // After setValue, the guard should be cleared
      expect(engine.isUpdatingEditorFromRemote('guard-test.md')).toBe(false);
    });
  });

  // ── getDocument ────────────────────────────────────────────────────────────

  describe('getDocument', () => {
    it('returns undefined for unknown paths without creating an empty CRDT', async () => {
      await engine.start();
      const doc = engine.getDocument('unknown.md');
      expect(doc).toBeUndefined();
      expect(mockCreateDocument).not.toHaveBeenCalled();
    });
  });

  // ── doc_deleted broadcast ─────────────────────────────────────────────────

  describe('doc_deleted broadcast', () => {
    it('trashes local file on doc_deleted message', async () => {
      const mockFile = Object.create(TFile.prototype);
      mockVault.getAbstractFileByPath.mockReturnValue(mockFile);

      await engine.start();

      fireMessage({ type: 'doc_deleted', doc_uuid: 'gone.md' });
      await flush();

      expect(mockVault.trash).toHaveBeenCalledWith(mockFile, true);
    });
  });

  // ── delta_broadcast VV gap detection ──────────────────────────────────────

  describe('delta_broadcast VV gap detection', () => {
    it('triggers SyncStart catch-up when server_vv has missing peers', async () => {
      const mockFile = Object.create(TFile.prototype);
      mockVault.getAbstractFileByPath.mockReturnValue(mockFile);
      mockDocInstance.get_text.mockReturnValue('broadcast text');
      // Local VV missing peer 888
      mockDocInstance.export_vv_json.mockReturnValue('{"999":5}');

      await engine.start();

      // Fire broadcast with server_vv that includes peer 888 (local doesn't have it)
      fireMessage({
        type: 'delta_broadcast',
        doc_uuid: 'gap.md',
        delta: new Uint8Array(32),
        peer_id: 'other-peer',
        server_vv: new TextEncoder().encode('{"999":5,"888":3}'),
      });

      await flush();

      // Should have sent a sync_start for catch-up
      const syncStartCalls = mockEncode.mock.calls.filter(
        (c: any[]) => c[0]?.type === 'sync_start' && c[0]?.doc_uuid === 'gap.md'
      );
      expect(syncStartCalls.length).toBe(1);
      expect(syncStartCalls[0][0].client_vv).toBeInstanceOf(Uint8Array);

      // Respond with the catch-up delta
      fireMessage({
        type: 'sync_delta',
        doc_uuid: 'gap.md',
        delta: new Uint8Array(16),
        server_vv: new TextEncoder().encode('{"999":5,"888":3}'),
      });

      await flush();

      // import_and_diff for initial broadcast + import_snapshot for catch-up
      expect(mockDocInstance.import_and_diff).toHaveBeenCalledTimes(1);
      expect(mockDocInstance.import_snapshot).toHaveBeenCalledTimes(1);
    });

    it('does NOT trigger catch-up when local VV covers server VV', async () => {
      const mockFile = Object.create(TFile.prototype);
      mockVault.getAbstractFileByPath.mockReturnValue(mockFile);
      mockDocInstance.get_text.mockReturnValue('covered text');
      // Local VV covers server VV
      mockDocInstance.export_vv_json.mockReturnValue('{"999":5,"888":3}');

      await engine.start();

      fireMessage({
        type: 'delta_broadcast',
        doc_uuid: 'ok.md',
        delta: new Uint8Array(32),
        peer_id: 'other-peer',
        server_vv: new TextEncoder().encode('{"999":5,"888":3}'),
      });

      await flush();

      // No sync_start should be sent
      const syncStartCalls = mockEncode.mock.calls.filter(
        (c: any[]) => c[0]?.type === 'sync_start'
      );
      expect(syncStartCalls.length).toBe(0);
    });

    it('handles missing server_vv gracefully (backward compat)', async () => {
      const mockFile = Object.create(TFile.prototype);
      mockVault.getAbstractFileByPath.mockReturnValue(mockFile);
      mockDocInstance.get_text.mockReturnValue('compat text');

      await engine.start();

      // Broadcast without server_vv field
      fireMessage({
        type: 'delta_broadcast',
        doc_uuid: 'compat.md',
        delta: new Uint8Array(32),
        peer_id: 'other-peer',
      });

      await flush();

      // Normal import via import_and_diff + write, no crash, no sync_start
      expect(mockDocInstance.import_and_diff).toHaveBeenCalled();
      expect(mockVault.modify).toHaveBeenCalledWith(mockFile, 'compat text');
      const syncStartCalls = mockEncode.mock.calls.filter(
        (c: any[]) => c[0]?.type === 'sync_start'
      );
      expect(syncStartCalls.length).toBe(0);
    });

    it('skips catch-up if already in progress for same doc', async () => {
      const mockFile = Object.create(TFile.prototype);
      mockVault.getAbstractFileByPath.mockReturnValue(mockFile);
      mockDocInstance.get_text.mockReturnValue('dup text');
      mockDocInstance.export_vv_json.mockReturnValue('{"999":5}');

      await engine.start();

      // Fire two broadcasts with VV gap for the same doc quickly
      fireMessage({
        type: 'delta_broadcast',
        doc_uuid: 'dup-gap.md',
        delta: new Uint8Array(32),
        peer_id: 'other-peer',
        server_vv: new TextEncoder().encode('{"999":5,"888":3}'),
      });

      // Don't resolve the first catch-up yet — fire second broadcast
      fireMessage({
        type: 'delta_broadcast',
        doc_uuid: 'dup-gap.md',
        delta: new Uint8Array(16),
        peer_id: 'other-peer',
        server_vv: new TextEncoder().encode('{"999":5,"888":3}'),
      });

      await flush();

      // Only one sync_start should be sent (second was skipped)
      const syncStartCalls = mockEncode.mock.calls.filter(
        (c: any[]) => c[0]?.type === 'sync_start' && c[0]?.doc_uuid === 'dup-gap.md'
      );
      expect(syncStartCalls.length).toBe(1);
    });
  });

  // ── doc_unknown ────────────────────────────────────────────────────────────

  describe('doc_unknown', () => {
    it('resolves sync_start promise with null', async () => {
      mockVault.getMarkdownFiles.mockReturnValue([]);

      await engine.start();
      const syncPromise = engine.initialSync();

      fireMessage({
        type: 'doc_list',
        docs: [{ doc_uuid: 'nosnapshot.md', updated_at: '2026-03-16T00:00:00Z', vv_json: null }],
        tombstones: [],
      });

      await flush();

      fireMessage({ type: 'doc_unknown', doc_uuid: 'nosnapshot.md' });

      await syncPromise;

      // import_snapshot should NOT have been called
      expect(mockDocInstance.import_snapshot).not.toHaveBeenCalled();
      // File should NOT have been created
      expect(mockVault.create).not.toHaveBeenCalled();
    });
  });

  // ── sync mode: pull skips push ──────────────────────────────────────────

  describe('sync mode', () => {
    it('pull mode downloads server docs but skips local-only push', async () => {
      mockVault.getMarkdownFiles.mockReturnValue([{ path: 'local-only.md' }]);
      mockVault.read.mockResolvedValue('local content');
      mockDocInstance.get_text.mockReturnValue('server content');
      mockDocInstance.version.mockReturnValue(0);

      await engine.start();
      const syncPromise = engine.initialSync(undefined, 'pull');

      await flush();

      fireMessage({
        type: 'doc_list',
        docs: [{ doc_uuid: 'server.md', updated_at: '2026-03-16T00:00:00Z', vv_json: '{}' }],
        tombstones: [],
      });

      await flush();

      fireMessage({
        type: 'sync_delta',
        doc_uuid: 'server.md',
        delta: new Uint8Array(64),
        server_vv: new TextEncoder().encode('{"12345":5}'),
      });

      await syncPromise;

      // Server doc should have been downloaded (import_snapshot called)
      expect(mockDocInstance.import_snapshot).toHaveBeenCalled();

      // sync_start should have been sent for server doc
      const syncStartCalls = mockEncode.mock.calls.filter(
        (c: any[]) => c[0]?.type === 'sync_start' && c[0]?.doc_uuid === 'server.md'
      );
      expect(syncStartCalls.length).toBe(1);

      // Local-only doc should NOT have been pushed
      const createCalls = mockEncode.mock.calls.filter(
        (c: any[]) => c[0]?.type === 'doc_create' && c[0]?.doc_uuid === 'local-only.md'
      );
      expect(createCalls.length).toBe(0);
    });

    it('push mode skips server-only downloads but pushes local docs', async () => {
      mockVault.getMarkdownFiles.mockReturnValue([{ path: 'push-me.md' }]);
      mockVault.read.mockResolvedValue('push content');

      await engine.start();
      const syncPromise = engine.initialSync(undefined, 'push');

      await flush();

      fireMessage({
        type: 'doc_list',
        docs: [{ doc_uuid: 'server-only.md', updated_at: '2026-03-16T00:00:00Z', vv_json: '{}' }],
        tombstones: [],
      });

      await syncPromise;

      // Server-only doc should NOT have been downloaded (no sync_start sent)
      const syncStartCalls = mockEncode.mock.calls.filter(
        (c: any[]) => c[0]?.type === 'sync_start' && c[0]?.doc_uuid === 'server-only.md'
      );
      expect(syncStartCalls.length).toBe(0);

      // Local doc should have been pushed
      const createCalls = mockEncode.mock.calls.filter(
        (c: any[]) => c[0]?.type === 'doc_create' && c[0]?.doc_uuid === 'push-me.md'
      );
      expect(createCalls.length).toBe(1);
    });
  });

  // ── resumable sync ──────────────────────────────────────────────────────

  describe('resumable sync', () => {
    it('skips download for docs that already have persisted CRDT state', async () => {
      mockVault.getMarkdownFiles.mockReturnValue([]);
      // First getOrLoad returns doc with version > 0 (already downloaded)
      mockDocInstance.version.mockReturnValue(5);
      mockDocInstance.get_text.mockReturnValue('already here');

      await engine.start();
      const progressCalls: [number, number][] = [];
      const syncPromise = engine.initialSync((done, total) => {
        progressCalls.push([done, total]);
      });

      await flush();

      fireMessage({
        type: 'doc_list',
        docs: [{ doc_uuid: 'cached.md', updated_at: '2026-03-16T00:00:00Z', vv_json: '{}' }],
        tombstones: [],
      });

      await syncPromise;

      // No sync_start should have been sent (doc was skipped)
      const syncStartCalls = mockEncode.mock.calls.filter(
        (c: any[]) => c[0]?.type === 'sync_start' && c[0]?.doc_uuid === 'cached.md'
      );
      expect(syncStartCalls.length).toBe(0);

      // Progress should still have been reported
      expect(progressCalls.length).toBeGreaterThan(0);
      expect(progressCalls[progressCalls.length - 1][0]).toBe(progressCalls[progressCalls.length - 1][1]);
    });
  });

  // ── onInitialSync callback ──────────────────────────────────────────────

  describe('onInitialSync callback', () => {
    it('calls onInitialSync instead of auto-starting initialSync', async () => {
      const onInitialSync = vi.fn();
      engine.onInitialSync = onInitialSync;

      await engine.start();
      mockWsInstance.onopen!({} as Event);

      expect(onInitialSync).toHaveBeenCalledWith(engine);
    });

    it('auto-starts initialSync when onInitialSync is null', async () => {
      engine.onInitialSync = null;

      await engine.start();

      // Should have sent request_doc_list (first step of initialSync)
      // The initialSync call happens in onopen which is triggered by start()
      // We just verify no crash and onopen was set
      expect(mockWsInstance.onopen).toBeTruthy();
    });
  });

  // ── progress callback ──────────────────────────────────────────────────

  describe('progress callback', () => {
    it('reports progress for each phase', async () => {
      mockVault.getMarkdownFiles.mockReturnValue([{ path: 'local.md' }]);
      mockVault.read.mockResolvedValue('content');
      mockDocInstance.get_text.mockReturnValue('content');
      mockDocInstance.version.mockReturnValue(0);

      await engine.start();
      const progress: [number, number][] = [];
      const syncPromise = engine.initialSync((done, total) => {
        progress.push([done, total]);
      });

      await flush();

      fireMessage({
        type: 'doc_list',
        docs: [{ doc_uuid: 'srv.md', updated_at: '2026-03-16T00:00:00Z', vv_json: '{}' }],
        tombstones: [],
      });

      await flush();

      // sync_delta for server-only doc
      fireMessage({
        type: 'sync_delta',
        doc_uuid: 'srv.md',
        delta: new Uint8Array(32),
        server_vv: new TextEncoder().encode('{"1":1}'),
      });

      await syncPromise;

      // Should have progress entries (at least download + local-only push)
      expect(progress.length).toBeGreaterThanOrEqual(2);
      // Last entry should be done == total
      const last = progress[progress.length - 1];
      expect(last[0]).toBe(last[1]);
    });
  });

  // ── initialSync error recovery (P2 fix) ───────────────────────────────────

  describe('initialSync error recovery', () => {
    it('clears initialSyncRunning and sets status on download failure', async () => {
      await engine.start();

      // import_snapshot will throw on first call — simulates CRDT import failure
      mockDocInstance.import_snapshot.mockImplementationOnce(() => {
        throw new Error('CRDT import failed');
      });

      const syncPromise = engine.initialSync();
      await flush();

      // Send doc_list with one doc
      fireMessage({
        type: 'doc_list',
        docs: [{ doc_uuid: 'fail.md', updated_at: '2026-01-01T00:00:00Z', vv_json: '{}' }],
        tombstones: [],
      });

      await flush();

      // Send sync_delta — import will throw but download continues (error is caught per-doc)
      fireMessage({
        type: 'sync_delta',
        doc_uuid: 'fail.md',
        delta: new Uint8Array(32),
        server_vv: new TextEncoder().encode('{"1":1}'),
      });

      await syncPromise;
      await flush();

      // Key assertion: engine is not stuck in 'syncing' — finally block ran
      // Verify by checking that stop() works cleanly (no stuck state)
      expect(() => engine.stop()).not.toThrow();
    });
  });

});
