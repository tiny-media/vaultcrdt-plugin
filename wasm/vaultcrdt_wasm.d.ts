/* tslint:disable */
/* eslint-disable */

/**
 * WASM-exposed wrapper around `SyncDocument`.
 */
export class WasmSyncDocument {
    free(): void;
    [Symbol.dispose](): void;
    delete_text(pos: number, len: number): void;
    /**
     * Export only ops since the given server VV (JSON string from SyncDelta.server_vv).
     */
    export_delta_since_vv_json(vv_json: string): Uint8Array;
    /**
     * Export a full snapshot (includes operation history for server-side merge).
     */
    export_snapshot(): Uint8Array;
    /**
     * Export the version vector as a JSON string, e.g. `{"12345":47}`.
     * Keys are peer IDs (u64 as strings), values are op counters.
     */
    export_vv_json(): string;
    get_text(): string;
    /**
     * Import a delta and return a JSON string of text diff ops.
     * Returns `[{"retain":5},{"insert":"xyz"},{"delete":2}]` or empty string if no change.
     */
    import_and_diff(delta: Uint8Array): string;
    /**
     * Import a snapshot (full or shallow) or delta into the document.
     */
    import_snapshot(snapshot: Uint8Array): void;
    insert_text(pos: number, text: string): void;
    constructor(doc_uuid: string, peer_id: string);
    sync_from_disk(new_text: string): void;
    /**
     * Returns true if the CRDT text equals `text` — avoids allocating a JS string.
     */
    text_matches(text: string): boolean;
    /**
     * JS has no u64; f64 has 53 bits of precision which is sufficient for Loro version counters.
     */
    version(): number;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_wasmsyncdocument_free: (a: number, b: number) => void;
    readonly wasmsyncdocument_delete_text: (a: number, b: number, c: number, d: number) => void;
    readonly wasmsyncdocument_export_delta_since_vv_json: (a: number, b: number, c: number, d: number) => void;
    readonly wasmsyncdocument_export_snapshot: (a: number, b: number) => void;
    readonly wasmsyncdocument_export_vv_json: (a: number, b: number) => void;
    readonly wasmsyncdocument_get_text: (a: number, b: number) => void;
    readonly wasmsyncdocument_import_and_diff: (a: number, b: number, c: number, d: number) => void;
    readonly wasmsyncdocument_import_snapshot: (a: number, b: number, c: number, d: number) => void;
    readonly wasmsyncdocument_insert_text: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly wasmsyncdocument_new: (a: number, b: number, c: number, d: number) => number;
    readonly wasmsyncdocument_sync_from_disk: (a: number, b: number, c: number) => void;
    readonly wasmsyncdocument_text_matches: (a: number, b: number, c: number) => number;
    readonly wasmsyncdocument_version: (a: number) => number;
    readonly __wbindgen_export: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export2: (a: number, b: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
