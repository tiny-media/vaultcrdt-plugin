use std::error::Error;
use std::io::Cursor;

use svg_hush::Filter;
use vaultcrdt_crdt::document::SyncDocument;
use wasm_bindgen::prelude::*;

/// Canonical attachment blob path key (v1), or `undefined` if the path is not a
/// syncable attachment path. Oracle: `docs/blob-path-key-vectors.json`.
#[wasm_bindgen]
pub fn blob_path_key(path: &str) -> Option<String> {
    vaultcrdt_core::blob_path_key(path)
}

/// Lowercase-hex BLAKE3 digest of `data` — the content hash of an attachment blob.
#[wasm_bindgen]
pub fn blake3_hex(data: &[u8]) -> String {
    blake3::hash(data).to_hex().to_string()
}

fn format_ferr(err: svg_hush::FError) -> String {
    let mut msg = format!("svg: {err}");
    let mut src = Error::source(&err);
    while let Some(cause) = src {
        msg.push_str(": ");
        msg.push_str(&cause.to_string());
        src = cause.source();
    }
    msg
}

fn sanitize_svg_bytes(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut f = Filter::new();
    f.set_data_url_filter(svg_hush::data_url_filter::allow_standard_images);
    let mut dest = Cursor::new(Vec::new());
    f.filter(Cursor::new(data), &mut dest).map_err(format_ferr)?;
    Ok(dest.into_inner())
}

/// Sanitize SVG bytes with the protocol-pinned svg-hush config. SYNC — JS does not await.
#[wasm_bindgen]
pub fn sanitize_svg(data: &[u8]) -> Result<Vec<u8>, JsValue> {
    sanitize_svg_bytes(data).map_err(|s| JsValue::from_str(&s))
}

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
    use super::sanitize_svg_bytes;
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
    fn test_blake3_hex_known_vector() {
        // BLAKE3 test vector for the empty input and for b"abc".
        assert_eq!(
            blake3_hex(b""),
            "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262"
        );
        assert_eq!(
            blake3_hex(b"abc"),
            "6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85"
        );
        assert_eq!(blake3_hex(b"abc").len(), 64);
        assert_ne!(blake3_hex(b"abc"), blake3_hex(b"abd"));
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

    const SCRIPT_SVG: &[u8] = br#"<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="10" height="10"/></svg>"#;
    const CLEAN_SVG: &[u8] =
        br#"<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>"#;
    const DATA_URL_SVG: &[u8] = br#"<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="/></svg>"#;

    #[test]
    fn test_sanitize_svg_strips_script_keeps_rect() {
        let out = sanitize_svg_bytes(SCRIPT_SVG).expect("script svg should sanitize");
        let text = String::from_utf8(out).expect("utf8");
        assert!(text.contains("<rect"), "{text}");
        assert!(!text.contains("<script"), "{text}");
        assert!(!text.contains("alert"), "{text}");
    }

    #[test]
    fn test_sanitize_svg_idempotent() {
        let once = sanitize_svg_bytes(SCRIPT_SVG).unwrap();
        let twice = sanitize_svg_bytes(&once).unwrap();
        assert_eq!(once, twice, "script-svg output must be idempotent");

        let a = sanitize_svg_bytes(CLEAN_SVG).unwrap();
        let b = sanitize_svg_bytes(&a).unwrap();
        assert_eq!(a, b, "clean svg output must be idempotent");
    }

    #[test]
    fn test_sanitize_svg_rejects_jpeg() {
        let jpeg = [0xFFu8, 0xD8, 0xFF, 0xE0, 0x00, 0x10, b'J', b'F', b'I', b'F'];
        let err = sanitize_svg_bytes(&jpeg).expect_err("jpeg must fail");
        assert!(err.starts_with("svg: "), "{err}");
    }

    #[test]
    fn test_sanitize_svg_keeps_png_data_url() {
        let out = sanitize_svg_bytes(DATA_URL_SVG).expect("data-url svg");
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("data:image/png;base64,"), "{text}");
    }

    #[test]
    fn test_svg_sanitize_vectors_json() {
        use base64::Engine;
        let raw = include_str!("../../../docs/svg-sanitize-vectors.json");
        let doc: serde_json::Value = serde_json::from_str(raw).expect("valid svg vectors JSON");
        let cases = doc.as_array().expect("array");
        assert!(cases.len() >= 4, "need script, clean, data-url, idempotence");
        for v in cases {
            let name = v["name"].as_str().expect("name");
            let input = base64::engine::general_purpose::STANDARD
                .decode(v["input_b64"].as_str().expect("input_b64"))
                .unwrap_or_else(|e| panic!("{name}: {e}"));
            let expected = v["output_blake3_hex"].as_str().expect("output_blake3_hex");
            let out = sanitize_svg_bytes(&input)
                .unwrap_or_else(|e| panic!("{name}: sanitize failed: {e}"));
            assert_eq!(blake3_hex(&out), expected, "vector {name}");
        }
    }
}
