use vaultcrdt_crdt::document::SyncDocument;
use wasm_bindgen::prelude::*;

/// WASM-exposed wrapper around `SyncDocument`.
#[wasm_bindgen]
pub struct WasmSyncDocument {
    inner: SyncDocument,
}

#[wasm_bindgen]
impl WasmSyncDocument {
    #[wasm_bindgen(constructor)]
    pub fn new(doc_uuid: &str, peer_id: &str) -> Self {
        Self { inner: SyncDocument::new(doc_uuid, peer_id) }
    }

    pub fn insert_text(&self, pos: usize, text: &str) -> Result<(), JsValue> {
        self.inner.insert_text(pos, text).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    pub fn delete_text(&self, pos: usize, len: usize) -> Result<(), JsValue> {
        self.inner.delete_text(pos, len).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    pub fn get_text(&self) -> String {
        self.inner.get_text()
    }

    /// JS has no u64; f64 has 53 bits of precision which is sufficient for Loro version counters.
    pub fn version(&self) -> f64 {
        self.inner.version() as f64
    }

    pub fn sync_from_disk(&self, new_text: &str) {
        self.inner.sync_from_disk(new_text);
    }

    /// Export a full snapshot (includes operation history for server-side merge).
    pub fn export_snapshot(&self) -> Result<Vec<u8>, JsValue> {
        self.inner.export_full_snapshot().map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Import a snapshot (full or shallow) or delta into the document.
    pub fn import_snapshot(&self, snapshot: &[u8]) -> Result<(), JsValue> {
        self.inner.import_delta(snapshot).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Export the version vector as a JSON string, e.g. `{"12345":47}`.
    /// Keys are peer IDs (u64 as strings), values are op counters.
    pub fn export_vv_json(&self) -> String {
        let vv = self.inner.export_vv();
        serde_json::to_string(&vv).unwrap_or_else(|_| "{}".to_string())
    }

    /// Export only ops since the given server VV (JSON string from SyncDelta.server_vv).
    pub fn export_delta_since_vv_json(&self, vv_json: &str) -> Result<Vec<u8>, JsValue> {
        self.inner
            .export_updates_since_vv_json(vv_json)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Returns true if the CRDT text equals `text` — avoids allocating a JS string.
    pub fn text_matches(&self, text: &str) -> bool {
        self.inner.text_matches(text)
    }

    /// Import a delta and return a JSON string of text diff ops.
    /// Returns `[{"retain":5},{"insert":"xyz"},{"delete":2}]` or empty string if no change.
    pub fn import_and_diff(&self, delta: &[u8]) -> Result<String, JsValue> {
        self.inner.import_and_diff(delta).map_err(|e| JsValue::from_str(&e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_export_vv_json_roundtrip() {
        let doc = WasmSyncDocument::new("test-doc", "peer-a");
        let vv_empty: serde_json::Value =
            serde_json::from_str(&doc.export_vv_json()).expect("valid JSON");
        assert_eq!(vv_empty, serde_json::json!({}), "new doc has empty VV");

        doc.insert_text(0, "hello").unwrap();
        let vv_after: serde_json::Value =
            serde_json::from_str(&doc.export_vv_json()).expect("valid JSON");
        assert!(vv_after.as_object().unwrap().len() == 1, "one peer after insert");

        // VV must change after another insert
        doc.insert_text(5, " world").unwrap();
        let vv_after2: serde_json::Value =
            serde_json::from_str(&doc.export_vv_json()).expect("valid JSON");
        assert_ne!(vv_after, vv_after2, "VV changes with new ops");
    }

    #[test]
    fn test_import_and_diff_roundtrip() {
        let doc_a = WasmSyncDocument::new("test-doc", "peer-a");
        let doc_b = WasmSyncDocument::new("test-doc", "peer-b");

        doc_a.insert_text(0, "Hello").unwrap();
        let snapshot = doc_a.export_snapshot().unwrap();

        let diff_json = doc_b.import_and_diff(&snapshot).unwrap();
        assert!(!diff_json.is_empty());
        let ops: Vec<serde_json::Value> = serde_json::from_str(&diff_json).unwrap();
        assert_eq!(ops[0]["insert"], "Hello");
        assert_eq!(doc_b.get_text(), "Hello");
    }

    #[test]
    fn test_text_matches() {
        let doc = WasmSyncDocument::new("test-doc", "peer-a");
        assert!(doc.text_matches(""), "empty doc matches empty string");
        assert!(!doc.text_matches("x"), "empty doc does not match 'x'");

        doc.insert_text(0, "hello").unwrap();
        assert!(doc.text_matches("hello"), "matches inserted text");
        assert!(!doc.text_matches("world"), "does not match different text");
    }
}
