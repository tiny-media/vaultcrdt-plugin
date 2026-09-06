import initWasmModule, {
  WasmSyncDocument,
} from '../wasm/vaultcrdt_wasm';

export type { WasmSyncDocument };

let initialized = false;

/**
 * Initialize the WASM module once. Safe to call multiple times.
 * The bytes come from the caller (the plugin reads the sibling
 * `vaultcrdt_wasm_bg.wasm` next to main.js); a failing loader leaves the
 * guard unset so a later call can retry.
 */
export async function initWasm(loadBytes: () => Promise<Uint8Array>): Promise<void> {
  if (initialized) return;
  await initWasmModule({ module_or_path: await loadBytes() });
  initialized = true;
}

/**
 * Create a new CRDT document.
 * Requires `initWasm()` to have been awaited first.
 */
export function createDocument(docUuid = 'temp', peerId = '0'): WasmSyncDocument {
  return new WasmSyncDocument(docUuid, peerId);
}
