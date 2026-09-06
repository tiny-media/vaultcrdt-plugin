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

// Mock the WASM JS bindings
vi.mock('../../wasm/vaultcrdt_wasm', () => ({
  default: mockInitWasmModule,
  WasmSyncDocument: MockWasmSyncDocument,
}));

import { gzipSync } from 'fflate';

import { initWasm, createDocument } from '../wasm-bridge';

// ── Tests ─────────────────────────────────────────────────────────────────────

// esbuild substitutes this at bundle time; under vitest it must be defined
// here. A real gzip stream of a wasm magic header keeps both inflate paths
// (DecompressionStream and the fflate fallback) on genuine input.
const WASM_MAGIC = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
vi.stubGlobal(
  '__VAULTCRDT_WASM_GZ_B64__',
  Buffer.from(gzipSync(WASM_MAGIC)).toString('base64'),
);

describe('initWasm', () => {
  beforeEach(() => {
    mockInitWasmModule.mockClear();
  });

  it('inflates the embedded module and passes the exact bytes on', async () => {
    await expect(initWasm()).resolves.toBeUndefined();
    expect(mockInitWasmModule).toHaveBeenCalledTimes(1);
    const arg = mockInitWasmModule.mock.calls[0][0] as { module_or_path: Uint8Array };
    // The inflated bytes must be the original input, not the compressed form.
    expect(Array.from(arg.module_or_path)).toEqual(Array.from(WASM_MAGIC));
  });

  // iOS 16.0-16.3 has no DecompressionStream. That path cannot be reached on
  // the devices we test on, so it is pinned here instead.
  it('falls back to fflate when DecompressionStream is absent', async () => {
    const native = globalThis.DecompressionStream;
    // @ts-expect-error deliberately removing the global for this test
    delete globalThis.DecompressionStream;
    // A fresh module registry, so the singleton guard does not short-circuit.
    vi.resetModules();
    try {
      const { initWasm: freshInit } = await import('../wasm-bridge');
      await expect(freshInit()).resolves.toBeUndefined();
      const call = mockInitWasmModule.mock.calls.at(-1) as [{ module_or_path: Uint8Array }];
      expect(Array.from(call[0].module_or_path)).toEqual(Array.from(WASM_MAGIC));
    } finally {
      globalThis.DecompressionStream = native;
      vi.resetModules();
    }
  });

  it('is safe to call multiple times and initializes only once', async () => {
    await expect(initWasm()).resolves.toBeUndefined();
    await expect(initWasm()).resolves.toBeUndefined();
    // Guard already set by the first test in this file.
    expect(mockInitWasmModule).not.toHaveBeenCalled();
  });
});

describe('createDocument', () => {
  it('constructs a WasmSyncDocument with default arguments', () => {
    const doc = createDocument();
    expect(MockWasmSyncDocument).toHaveBeenCalledWith('temp', '0');
    expect(doc).toBe(mockDocInstance);
  });

  it('passes custom docUuid and peerId to constructor', () => {
    MockWasmSyncDocument.mockClear();
    createDocument('my-doc', 'peer-1');
    expect(MockWasmSyncDocument).toHaveBeenCalledWith('my-doc', 'peer-1');
  });

  it('returned document exposes get_text()', () => {
    const doc = createDocument();
    expect(doc.get_text()).toBe('');
  });

  it('returned document exposes version()', () => {
    const doc = createDocument();
    expect(doc.version()).toBe(0);
  });

  it('returned document exposes export_vv_json()', () => {
    const doc = createDocument();
    expect(doc.export_vv_json()).toBe('{}');
  });

  it('returned document exposes export_snapshot()', () => {
    const doc = createDocument();
    expect(doc.export_snapshot()).toBeInstanceOf(Uint8Array);
  });

  it('returns a document on each call', () => {
    const doc1 = createDocument();
    const doc2 = createDocument();
    expect(doc1).toBeDefined();
    expect(doc2).toBeDefined();
  });
});
