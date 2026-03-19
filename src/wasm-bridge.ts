// WASM binary is inlined by esbuild's binary loader
// @ts-ignore — .wasm resolved as binary (Uint8Array) by esbuild
import wasmBytes from '../wasm/vaultcrdt_wasm_bg.wasm';
import initWasmModule, {
  WasmSyncDocument,
} from '../wasm/vaultcrdt_wasm';

export type { WasmSyncDocument };

let initialized = false;

/** Initialize the WASM module once. Safe to call multiple times. */
export async function initWasm(): Promise<void> {
  if (initialized) return;
  await initWasmModule({ module_or_path: wasmBytes });
  initialized = true;
}

/**
 * Create a new CRDT document bound to a document UUID and peer ID.
 * Requires `initWasm()` to have been awaited first.
 */
export function createDocument(docUuid: string, peerId: string): WasmSyncDocument {
  return new WasmSyncDocument(docUuid, peerId);
}
