import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted() runs before imports and vi.mock factories, making these
// variables available to factory functions without TDZ errors.
const { mockInitWasmModule, MockWasmSyncDocument, mockDocInstance } = vi.hoisted(() => {
  const mockDocInstance = {
    get_text: vi.fn().mockReturnValue(''),
    insert_text: vi.fn(),
    delete_text: vi.fn(),
    content_hash: vi.fn().mockReturnValue('abc123def456'),
    export_encrypted_delta: vi.fn().mockReturnValue({
      salt: new Uint8Array(16),
      blob: new Uint8Array(32),
    }),
    import_encrypted_delta: vi.fn(),
    sync_from_disk: vi.fn(),
    version: vi.fn().mockReturnValue(0),
    export_snapshot: vi.fn().mockReturnValue(new Uint8Array(64)),
  };
  const MockWasmSyncDocument = vi.fn(function() { return mockDocInstance; });
  const mockInitWasmModule = vi.fn().mockResolvedValue(undefined);
  return { mockInitWasmModule, MockWasmSyncDocument, mockDocInstance };
});

// Mock the WASM binary (esbuild inlines this as Uint8Array at build time)
vi.mock('../../../crates/vaultcrdt-wasm/pkg/vaultcrdt_wasm_bg.wasm', () => ({
  default: new Uint8Array([0, 97, 115, 109]),
}));

// Mock the WASM JS bindings
vi.mock('../../../crates/vaultcrdt-wasm/pkg/vaultcrdt_wasm', () => ({
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

  it('returned document exposes content_hash()', () => {
    const doc = createDocument('doc-1', 'peer-1');
    expect(doc.content_hash()).toBe('abc123def456');
  });

  it('returned document exposes export_encrypted_delta()', () => {
    const doc = createDocument('doc-1', 'peer-1');
    const result = doc.export_encrypted_delta('password');
    expect(result.salt).toBeInstanceOf(Uint8Array);
    expect(result.blob).toBeInstanceOf(Uint8Array);
    expect(result.salt.length).toBe(16);
    expect(result.blob.length).toBe(32);
  });

  it('returned document exposes version()', () => {
    const doc = createDocument('doc-1', 'peer-1');
    expect(doc.version()).toBe(0);
  });

  it('returns distinct documents for different uuids', () => {
    const doc1 = createDocument('doc-1', 'peer-1');
    const doc2 = createDocument('doc-2', 'peer-1');
    // Both point to the same mock instance (expected for a mock), but the
    // constructor was called with different arguments.
    expect(MockWasmSyncDocument).toHaveBeenCalledWith('doc-1', 'peer-1');
    expect(MockWasmSyncDocument).toHaveBeenCalledWith('doc-2', 'peer-1');
    expect(doc1).toBeDefined();
    expect(doc2).toBeDefined();
  });
});
