import { gunzipSync } from 'fflate';
import initWasmModule, {
  WasmSyncDocument,
} from '../wasm/vaultcrdt_wasm';

export type { WasmSyncDocument };

/**
 * gzip+base64 of `wasm/vaultcrdt_wasm_bg.wasm`, substituted by esbuild at
 * bundle time. The module is embedded because Obsidian's store and BRAT
 * install only main.js, manifest.json and styles.css.
 */
declare const __VAULTCRDT_WASM_GZ_B64__: string;

let initialized = false;

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Inflate the embedded module. Uses the engine's native gzip decoder where it
 * exists (Chromium 80+, Safari/iOS 16.4+) and falls back to fflate otherwise,
 * which keeps iOS 16.0–16.3 working. Both paths consume the same payload.
 */
async function inflate(gz: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'function') {
    const stream = new Blob([gz as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return gunzipSync(gz);
}

/**
 * Initialize the WASM module once. Safe to call multiple times.
 * A failing decode leaves the guard unset so a later call can retry.
 */
export async function initWasm(): Promise<void> {
  if (initialized) return;
  const wasmBytes = await inflate(base64ToBytes(__VAULTCRDT_WASM_GZ_B64__));
  await initWasmModule({ module_or_path: wasmBytes });
  initialized = true;
}

/**
 * Create a new CRDT document.
 * Requires `initWasm()` to have been awaited first.
 */
export function createDocument(docUuid = 'temp', peerId = '0'): WasmSyncDocument {
  return new WasmSyncDocument(docUuid, peerId);
}
