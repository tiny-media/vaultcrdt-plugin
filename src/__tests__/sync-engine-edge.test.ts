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
  };
});

vi.mock('obsidian', () => ({
  requestUrl: mockRequestUrl,
  App: vi.fn(),
  TFile: vi.fn(),
  MarkdownView: vi.fn(),
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

const makeApp = () =>
  ({
    vault: mockVault,
    workspace: {
      on: vi.fn(),
      getActiveViewOfType: vi.fn(() => null),
      iterateAllLeaves: vi.fn(),
    },
  }) as any;

const flush = async (n = 20) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

const fireMessage = (decoded: unknown) => {
  mockDecode.mockReturnValueOnce(decoded);
  mockWsInstance.onmessage!({ data: new ArrayBuffer(4) } as MessageEvent);
};

// ── Edge Case Tests ────────────────────────────────────────────────────────────

describe('SyncEngine — edge cases (S34)', () => {
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

  // ── offline delete queued and sent on reconnect ────────────────────────────

  it('offline delete queued and sent on reconnect', async () => {
    await engine.start();

    // Go offline
    mockWsInstance.readyState = 3; // CLOSED

    engine.onFileDeleted('offline-del.md');

    // No doc_delete sent while offline
    const deleteCalls = mockEncode.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'doc_delete' && c[0]?.doc_uuid === 'offline-del.md'
    );
    expect(deleteCalls.length).toBe(0);

    // Reconnect: simulate ws back online
    mockWsInstance.readyState = 1;
    mockVault.getMarkdownFiles.mockReturnValue([]);

    const syncPromise = engine.initialSync();
    await flush();

    fireMessage({ type: 'doc_list', docs: [], tombstones: [] });
    await syncPromise;

    // Now doc_delete should have been sent
    const deleteCallsAfter = mockEncode.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'doc_delete' && c[0]?.doc_uuid === 'offline-del.md'
    );
    expect(deleteCallsAfter.length).toBe(1);
  });

  // ── offline rename = delete + create on reconnect ──────────────────────────

  it('offline rename = delete + push on reconnect', async () => {
    await engine.start();

    // Go offline
    mockWsInstance.readyState = 3;

    engine.onFileRenamed('old.md', 'new.md', 'content');
    await flush();

    // Nothing sent while offline
    expect(mockEncode.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'doc_delete' && c[0]?.doc_uuid === 'old.md'
    ).length).toBe(0);

    // Reconnect
    mockWsInstance.readyState = 1;
    mockVault.getMarkdownFiles.mockReturnValue([{ path: 'new.md' }]);
    mockVault.read.mockResolvedValue('content');

    const syncPromise = engine.initialSync();
    await flush();
    fireMessage({ type: 'doc_list', docs: [], tombstones: [] });
    await syncPromise;

    // doc_delete for old path should have been flushed
    const deleteCalls = mockEncode.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'doc_delete' && c[0]?.doc_uuid === 'old.md'
    );
    expect(deleteCalls.length).toBe(1);

    // doc_create for new path (local-only push)
    const createCalls = mockEncode.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'doc_create' && c[0]?.doc_uuid === 'new.md'
    );
    expect(createCalls.length).toBe(1);
  });

  // ── multiple reconnects accumulate correctly ───────────────────────────────

  it('multiple reconnects accumulate correctly', async () => {
    await engine.start();

    // Cycle 1: online → edit → online push
    mockDocInstance.text_matches.mockReturnValue(false);
    engine.onFileChangedImmediate('a.md', 'v1');
    await flush();
    let pushCalls = mockEncode.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'sync_push' && c[0]?.doc_uuid === 'a.md'
    );
    expect(pushCalls.length).toBe(1);

    // Cycle 2: go offline, edit, reconnect
    mockWsInstance.readyState = 3;
    engine.onFileChangedImmediate('a.md', 'v2');
    await flush();

    // No push while offline (send guard)
    const pushAfterOffline = mockEncode.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'sync_push' && c[0]?.doc_uuid === 'a.md'
    );
    expect(pushAfterOffline.length).toBe(1); // still just the first push

    // Reconnect
    mockWsInstance.readyState = 1;
    mockVault.getMarkdownFiles.mockReturnValue([{ path: 'a.md' }]);
    mockVault.read.mockResolvedValue('v2');
    // After importing server delta, get_text returns merged content (differs from local)
    mockDocInstance.get_text.mockReturnValue('v2-merged');
    // text_matches = true: offline edits through Obsidian persist CRDT — no external disk change
    mockDocInstance.text_matches.mockReturnValue(true);
    mockDocInstance.version.mockReturnValue(5);
    // Client and server share peer "123" → shared history → normal merge
    mockDocInstance.export_vv_json.mockReturnValue('{"999":5,"123":1}');

    const syncPromise = engine.initialSync();
    await flush();

    fireMessage({
      type: 'doc_list',
      docs: [{ doc_uuid: 'a.md', updated_at: '2026-03-16T00:00:00Z', vv_json: '{"123":3}' }],
      tombstones: [],
    });
    await flush();

    fireMessage({
      type: 'sync_delta',
      doc_uuid: 'a.md',
      delta: new Uint8Array(16),
      server_vv: new TextEncoder().encode('{"123":3}'),
    });
    await syncPromise;

    // sync_push should have been sent during initialSync for the accumulated delta
    const finalPushCalls = mockEncode.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'sync_push' && c[0]?.doc_uuid === 'a.md'
    );
    expect(finalPushCalls.length).toBeGreaterThanOrEqual(1);
  });

  // ── large merge logged ─────────────────────────────────────────────────────

  it('large merge logged via console.warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await engine.start();

    // Simulate a broadcast where text grows significantly
    mockDocInstance.get_text
      .mockReturnValueOnce('short')           // textBefore
      .mockReturnValueOnce('a'.repeat(1000)); // textAfter (huge growth)
    mockVault.getAbstractFileByPath.mockReturnValue(null);

    fireMessage({
      type: 'delta_broadcast',
      doc_uuid: 'big.md',
      delta: new Uint8Array(512),
      peer_id: 'other',
    });
    await flush();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('large merge delta'),
      expect.objectContaining({
        path: 'big.md',
        beforeLen: 5,
        afterLen: 1000,
      })
    );

    warnSpy.mockRestore();
  });

  // ── pending deletes cleared after initial sync ─────────────────────────────

  it('pending deletes cleared after initial sync', async () => {
    await engine.start();

    // Queue deletes while offline
    mockWsInstance.readyState = 3;
    engine.onFileDeleted('x.md');
    engine.onFileDeleted('y.md');

    // Reconnect
    mockWsInstance.readyState = 1;
    mockVault.getMarkdownFiles.mockReturnValue([]);

    const syncPromise = engine.initialSync();
    await flush();
    fireMessage({ type: 'doc_list', docs: [], tombstones: [] });
    await syncPromise;

    // Both deletes flushed
    const deleteCalls = mockEncode.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'doc_delete'
    );
    expect(deleteCalls.length).toBe(2);

    // Second initialSync should NOT re-send them
    vi.clearAllMocks();
    mockWsInstance.readyState = 1;
    mockVault.getMarkdownFiles.mockReturnValue([]);
    const syncPromise2 = engine.initialSync();
    await flush();
    fireMessage({ type: 'doc_list', docs: [], tombstones: [] });
    await syncPromise2;

    const deleteCallsAfter = mockEncode.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'doc_delete'
    );
    expect(deleteCallsAfter.length).toBe(0);
  });

  // ── offline delete persists to journal file on disk ────────────────────────

  it('offline delete writes path to the delete-journal file', async () => {
    await engine.start();
    mockWsInstance.readyState = 3; // offline

    engine.onFileDeleted('notes/x.md');
    await flush();

    const journalWrites = mockAdapter.write.mock.calls.filter(
      (c: any[]) => typeof c[0] === 'string' && c[0].endsWith('delete-journal.json'),
    );
    expect(journalWrites.length).toBeGreaterThanOrEqual(1);
    const lastPayload = journalWrites[journalWrites.length - 1][1];
    expect(lastPayload).toContain('notes/x.md');
  });

  // ── journal-flagged paths are NOT redownloaded as server-only on reconnect ─

  it('server-only download skips paths present in the delete journal', async () => {
    // Preload the journal file so the fresh engine picks it up in start().
    mockAdapter.exists.mockImplementation(async (p: string) =>
      p.endsWith('delete-journal.json'),
    );
    mockAdapter.read.mockImplementation(async (p: string) => {
      if (p.endsWith('delete-journal.json')) {
        return JSON.stringify({ _version: 1, paths: ['ghost.md'] });
      }
      return '';
    });

    // Rebuild engine so start() picks up the preloaded journal.
    engine = new SyncEngine(makeApp(), makeSettings());
    await engine.start();

    mockVault.getMarkdownFiles.mockReturnValue([]);
    const syncPromise = engine.initialSync();
    await flush();

    fireMessage({
      type: 'doc_list',
      docs: [{ doc_uuid: 'ghost.md', updated_at: '2026-04-07T00:00:00Z', vv_json: '{}' }],
      tombstones: [],
    });
    await syncPromise;

    // The flush already sent a doc_delete for ghost.md before requestDocList.
    const deleteCalls = mockEncode.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'doc_delete' && c[0]?.doc_uuid === 'ghost.md',
    );
    expect(deleteCalls.length).toBe(1);

    // Critically: sync_start for the ghost path must NOT have been issued,
    // because the pending-delete filter excluded it from serverOnlyUuids.
    const syncStartCalls = mockEncode.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'sync_start' && c[0]?.doc_uuid === 'ghost.md',
    );
    expect(syncStartCalls.length).toBe(0);
  });

  // ── delete-ack hardening: online delete keeps journal entry until reconcile

  it('online delete keeps journal entry until reconcile (WS open)', async () => {
    await engine.start();
    mockWsInstance.readyState = 1; // OPEN

    engine.onFileDeleted('online-del.md');
    await flush();

    // doc_delete sent immediately
    const deleteCalls = mockEncode.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'doc_delete' && c[0]?.doc_uuid === 'online-del.md'
    );
    expect(deleteCalls.length).toBe(1);

    // Journal still contains the path (persisted to disk)
    const journalWrites = mockAdapter.write.mock.calls.filter(
      (c: any[]) => typeof c[0] === 'string' && c[0].endsWith('delete-journal.json'),
    );
    expect(journalWrites.length).toBeGreaterThanOrEqual(1);
    const lastPayload = journalWrites[journalWrites.length - 1][1];
    expect(lastPayload).toContain('online-del.md');
  });

  // ── delete-ack hardening: resend before request_doc_list on reconnect ──────

  it('reconnect resends pending deletes BEFORE request_doc_list', async () => {
    mockAdapter.exists.mockImplementation(async (p: string) =>
      p.endsWith('delete-journal.json'),
    );
    mockAdapter.read.mockImplementation(async (p: string) => {
      if (p.endsWith('delete-journal.json')) {
        return JSON.stringify({ _version: 1, paths: ['resent.md'] });
      }
      return '';
    });

    engine = new SyncEngine(makeApp(), makeSettings());
    await engine.start();

    mockVault.getMarkdownFiles.mockReturnValue([]);
    const syncPromise = engine.initialSync();
    await flush();

    // Capture index of doc_delete vs request_doc_list in the encode call log
    const sentTypes = mockEncode.mock.calls.map((c: any[]) => c[0]?.type);
    const deleteIdx = sentTypes.indexOf('doc_delete');
    const listIdx = sentTypes.indexOf('request_doc_list');
    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    expect(listIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeLessThan(listIdx);

    fireMessage({ type: 'doc_list', docs: [], tombstones: ['resent.md'] });
    await syncPromise;
  });

  // ── delete-ack hardening: tombstone → clear ────────────────────────────────

  it('reconcile clears journal entry when path is tombstoned on server', async () => {
    mockAdapter.exists.mockImplementation(async (p: string) =>
      p.endsWith('delete-journal.json'),
    );
    mockAdapter.read.mockImplementation(async (p: string) => {
      if (p.endsWith('delete-journal.json')) {
        return JSON.stringify({ _version: 1, paths: ['tombs.md'] });
      }
      return '';
    });

    engine = new SyncEngine(makeApp(), makeSettings());
    await engine.start();

    mockAdapter.write.mockClear();
    mockVault.getMarkdownFiles.mockReturnValue([]);
    const syncPromise = engine.initialSync();
    await flush();
    fireMessage({ type: 'doc_list', docs: [], tombstones: ['tombs.md'] });
    await syncPromise;

    // Journal persisted empty after reconcile
    const journalWrites = mockAdapter.write.mock.calls.filter(
      (c: any[]) => typeof c[0] === 'string' && c[0].endsWith('delete-journal.json'),
    );
    expect(journalWrites.length).toBeGreaterThanOrEqual(1);
    const lastPayload = journalWrites[journalWrites.length - 1][1];
    expect(lastPayload).not.toContain('tombs.md');
  });

  // ── delete-ack hardening: active on server → stays pending, not downloaded

  it('reconcile keeps journal entry and does not redownload when path still active', async () => {
    mockAdapter.exists.mockImplementation(async (p: string) =>
      p.endsWith('delete-journal.json'),
    );
    mockAdapter.read.mockImplementation(async (p: string) => {
      if (p.endsWith('delete-journal.json')) {
        return JSON.stringify({ _version: 1, paths: ['active.md'] });
      }
      return '';
    });

    engine = new SyncEngine(makeApp(), makeSettings());
    await engine.start();

    mockAdapter.write.mockClear();
    mockVault.getMarkdownFiles.mockReturnValue([]);
    const syncPromise = engine.initialSync();
    await flush();
    fireMessage({
      type: 'doc_list',
      docs: [{ doc_uuid: 'active.md', updated_at: '2026-04-07T00:00:00Z', vv_json: '{}' }],
      tombstones: [],
    });
    await syncPromise;

    // Resend happened
    const deleteCalls = mockEncode.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'doc_delete' && c[0]?.doc_uuid === 'active.md',
    );
    expect(deleteCalls.length).toBe(1);

    // Path was NOT redownloaded (pendingDeleteSnapshot filter)
    const syncStartCalls = mockEncode.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'sync_start' && c[0]?.doc_uuid === 'active.md',
    );
    expect(syncStartCalls.length).toBe(0);

    // Journal persisted still containing the path
    const journalWrites = mockAdapter.write.mock.calls.filter(
      (c: any[]) => typeof c[0] === 'string' && c[0].endsWith('delete-journal.json'),
    );
    expect(journalWrites.length).toBeGreaterThanOrEqual(1);
    const lastPayload = journalWrites[journalWrites.length - 1][1];
    expect(lastPayload).toContain('active.md');
  });

  // ── delete-ack hardening: neither branch (tombstone-GC / unknown path) ─────

  it('reconcile clears journal entry when path is neither tombstoned nor active', async () => {
    // Real case: server tombstone-expiry (default 90 days) has already GC'd
    // the tombstone, or the path never existed server-side at all.
    mockAdapter.exists.mockImplementation(async (p: string) =>
      p.endsWith('delete-journal.json'),
    );
    mockAdapter.read.mockImplementation(async (p: string) => {
      if (p.endsWith('delete-journal.json')) {
        return JSON.stringify({ _version: 1, paths: ['gc.md'] });
      }
      return '';
    });

    engine = new SyncEngine(makeApp(), makeSettings());
    await engine.start();

    mockAdapter.write.mockClear();
    mockVault.getMarkdownFiles.mockReturnValue([]);
    const syncPromise = engine.initialSync();
    await flush();
    fireMessage({ type: 'doc_list', docs: [], tombstones: [] });
    await syncPromise;

    const journalWrites = mockAdapter.write.mock.calls.filter(
      (c: any[]) => typeof c[0] === 'string' && c[0].endsWith('delete-journal.json'),
    );
    expect(journalWrites.length).toBeGreaterThanOrEqual(1);
    const lastPayload = journalWrites[journalWrites.length - 1][1];
    expect(lastPayload).not.toContain('gc.md');
  });

  // ── disjoint VV conflict after offline edit on both sides ─────────────────

  it('disjoint VV conflict after offline edit on both sides', async () => {
    // Simulates: both vaults have disjoint CRDT histories → disjoint-VV fork
    mockVault.getMarkdownFiles.mockReturnValue([{ path: 'recipe.md' }]);
    mockVault.read.mockResolvedValue('Moossmutzel');
    mockDocInstance.version.mockReturnValue(7);
    // text_matches = true: disk == CRDT; disjoint-VV check still fires based on VV mismatch
    mockDocInstance.text_matches.mockReturnValue(true);
    // Local peer-a, server peer-b → completely disjoint
    mockDocInstance.export_vv_json.mockReturnValue('{"peer-a":7}');
    // After importing server delta, tempDoc.get_text returns server content
    mockDocInstance.get_text.mockReturnValue('Rübenschänke');
    mockVault.getAbstractFileByPath.mockReturnValue(null);

    await engine.start();
    const syncPromise = engine.initialSync();

    await flush();

    fireMessage({
      type: 'doc_list',
      docs: [{ doc_uuid: 'recipe.md', updated_at: '2026-03-17T00:00:00Z', vv_json: '{"peer-b":5}' }],
      tombstones: [],
    });

    await flush();

    fireMessage({
      type: 'sync_delta',
      doc_uuid: 'recipe.md',
      delta: new Uint8Array(64),
      server_vv: new TextEncoder().encode('{"peer-b":5}'),
    });

    await syncPromise;

    // Should fork: conflict file with local content
    const conflictCreates = mockVault.create.mock.calls.filter(
      (c: any[]) => (c[0] as string).includes('conflict')
    );
    expect(conflictCreates.length).toBe(1);
    expect(conflictCreates[0][1]).toBe('Moossmutzel');

    // Should NOT have sent sync_push (we adopted server, not merged)
    const pushCalls = mockEncode.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'sync_push' && c[0]?.doc_uuid === 'recipe.md'
    );
    expect(pushCalls.length).toBe(0);
  });

  // ── offline edit persisted and pushed on reconnect ─────────────────────────

  it('offline edit persisted and pushed on reconnect', async () => {
    await engine.start();

    // Edit while offline — pushFileDelta still updates CRDT locally
    mockWsInstance.readyState = 3;
    engine.onFileChangedImmediate('note.md', 'offline edit');
    await flush();

    // No sync_push sent
    expect(mockEncode.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'sync_push' && c[0]?.doc_uuid === 'note.md'
    ).length).toBe(0);

    // But CRDT was updated
    expect(mockDocInstance.sync_from_disk).toHaveBeenCalledWith('offline edit');

    // Reconnect and initialSync pushes accumulated delta
    mockWsInstance.readyState = 1;
    mockVault.getMarkdownFiles.mockReturnValue([{ path: 'note.md' }]);
    mockVault.read.mockResolvedValue('offline edit');
    // text_matches = true: Obsidian edits persist CRDT state, so disk == CRDT on startup.
    // VV-based push detection handles server-gap regardless of content match.
    mockDocInstance.text_matches.mockReturnValue(true);
    mockDocInstance.version.mockReturnValue(7);
    // Client and server share peer "222" → shared history → normal merge (no fork)
    mockDocInstance.export_vv_json.mockReturnValue('{"111":7,"222":1}');
    mockDocInstance.get_text.mockReturnValue('offline edit merged');

    const syncPromise = engine.initialSync();
    await flush();

    fireMessage({
      type: 'doc_list',
      docs: [{ doc_uuid: 'note.md', updated_at: '2026-03-16T00:00:00Z', vv_json: '{"222":3}' }],
      tombstones: [],
    });
    await flush();

    fireMessage({
      type: 'sync_delta',
      doc_uuid: 'note.md',
      delta: new Uint8Array(16),
      server_vv: new TextEncoder().encode('{"222":3}'),
    });
    await syncPromise;

    // sync_push should have been sent during initialSync
    const pushCalls = mockEncode.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'sync_push' && c[0]?.doc_uuid === 'note.md'
    );
    expect(pushCalls.length).toBe(1);
  });

  // ── concurrent external-edit conflict fork ─────────────────────────────────

  it('forks when local file was edited externally AND server has different changes', async () => {
    // Scenario: user edited note.md in VS Code while Obsidian was closed (on this vault),
    // while another vault also made changes and synced to server.
    // Both have shared CRDT history (same peer IDs), so disjoint-VV check won't fire.
    // The concurrent external-edit check catches this case.
    mockVault.getMarkdownFiles.mockReturnValue([{ path: 'ext.md' }]);
    mockVault.read.mockResolvedValue('VS Code version');
    mockDocInstance.version.mockReturnValue(5);
    // text_matches = false: disk differs from CRDT (external editor changed the file)
    mockDocInstance.text_matches.mockReturnValue(false);
    // Shared history (same peer) → disjoint-VV check would NOT fork
    mockDocInstance.export_vv_json.mockReturnValue('{"999":5}');
    // Server (and temp doc) returns different content
    mockDocInstance.get_text.mockReturnValue('Server version');
    mockVault.getAbstractFileByPath.mockReturnValue(null);

    await engine.start();
    const syncPromise = engine.initialSync();

    await flush();

    fireMessage({
      type: 'doc_list',
      docs: [{ doc_uuid: 'ext.md', updated_at: '2026-03-17T00:00:00Z', vv_json: '{"999":7}' }],
      tombstones: [],
    });

    await flush();

    // First sync_delta: VV-based request
    fireMessage({
      type: 'sync_delta',
      doc_uuid: 'ext.md',
      delta: new Uint8Array(32),
      server_vv: new TextEncoder().encode('{"999":7}'),
    });

    await flush();

    // Second sync_delta: full snapshot request (null VV) after conflict detected
    fireMessage({
      type: 'sync_delta',
      doc_uuid: 'ext.md',
      delta: new Uint8Array(64),
      server_vv: new TextEncoder().encode('{"999":7}'),
    });

    await syncPromise;

    // Should have forked: conflict file with external (VS Code) content
    const conflictCreates = mockVault.create.mock.calls.filter(
      (c: any[]) => (c[0] as string).includes('conflict')
    );
    expect(conflictCreates.length).toBe(1);
    expect(conflictCreates[0][1]).toBe('VS Code version');

    // Should NOT have pushed our external edit ops (adopted server version)
    const pushCalls = mockEncode.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'sync_push' && c[0]?.doc_uuid === 'ext.md'
    );
    expect(pushCalls.length).toBe(0);
  });
});
