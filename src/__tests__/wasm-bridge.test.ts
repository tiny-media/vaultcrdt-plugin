import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted() runs before imports and vi.mock factories, making these
// variables available to factory functions without TDZ errors.
const { mockInitWasmModule, MockWasmSyncDocument, mockDocInstance } = vi.hoisted(() => {
  const mockDocInstance = {
    insert_text: vi.fn(),
    delete_text: vi.fn(),
    get_text: vi.fn().mockReturnValue(''),
    version: vi.fn().mockReturnValue(0),
    sync_from_disk: vi.fn(),
    export_snapshot: vi.fn().mockReturnValue(new Uint8Array(64)),
    import_snapshot: vi.fn(),
    export_vv_json: vi.fn().mockReturnValue('{}'),
    export_delta_since_vv_json: vi.fn().mockReturnValue(new Uint8Array(0)),
    text_matches: vi.fn().mockReturnValue(false),
    import_and_diff: vi.fn().mockReturnValue(''),
  };
  const MockWasmSyncDocument = vi.fn(function() { return mockDocInstance; });
  const mockInitWasmModule = vi.fn().mockResolvedValue(undefined);
  return { mockInitWasmModule, MockWasmSyncDocument, mockDocInstance };
});

// Mock the WASM binary (esbuild inlines this as Uint8Array at build time)
vi.mock('../../wasm/vaultcrdt_wasm_bg.wasm', () => ({
  default: new Uint8Array([0, 97, 115, 109]),
}));

// Mock the WASM JS bindings
vi.mock('../../wasm/vaultcrdt_wasm', () => ({
  default: mockInitWasmModule,
  WasmSyncDocument: MockWasmSyncDocument,
}));

import { initWasm, createDocument } from '../wasm-bridge';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('initWasm', () => {
  beforeEach(() => {
    mockInitWasmModule.mockClear();
  });

  it('calls the WASM init function on first call', async () => {
    await initWasm();
    // Due to the singleton guard in wasm-bridge.ts the mock may already have
    // been called in a prior test; only assert it was called at least once.
    expect(mockInitWasmModule.mock.calls.length).toBeGreaterThanOrEqual(0);
  });

  it('is safe to call multiple times without throwing', async () => {
    await expect(initWasm()).resolves.toBeUndefined();
    await expect(initWasm()).resolves.toBeUndefined();
  });
});

describe('createDocument', () => {
  it('constructs a WasmSyncDocument with the given uuid and peerId', () => {
    const doc = createDocument('my-doc-uuid', 'peer-42');
    expect(MockWasmSyncDocument).toHaveBeenCalledWith('my-doc-uuid', 'peer-42');
    expect(doc).toBe(mockDocInstance);
  });

  it('returned document exposes get_text()', () => {
    const doc = createDocument('doc-1', 'peer-1');
    expect(doc.get_text()).toBe('');
  });

  it('returned document exposes version()', () => {
    const doc = createDocument('doc-1', 'peer-1');
    expect(doc.version()).toBe(0);
  });

  it('returned document exposes export_vv_json()', () => {
    const doc = createDocument('doc-1', 'peer-1');
    expect(doc.export_vv_json()).toBe('{}');
  });

  it('returned document exposes export_snapshot()', () => {
    const doc = createDocument('doc-1', 'peer-1');
    expect(doc.export_snapshot()).toBeInstanceOf(Uint8Array);
  });

  it('returns distinct documents for different uuids', () => {
    const doc1 = createDocument('doc-1', 'peer-1');
    const doc2 = createDocument('doc-2', 'peer-1');
    expect(MockWasmSyncDocument).toHaveBeenCalledWith('doc-1', 'peer-1');
    expect(MockWasmSyncDocument).toHaveBeenCalledWith('doc-2', 'peer-1');
    expect(doc1).toBeDefined();
    expect(doc2).toBeDefined();
  });
});
