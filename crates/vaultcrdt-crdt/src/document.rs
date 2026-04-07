use std::collections::HashMap;

use loro::cursor::{CannotFindRelativePosition, Cursor, Side};
use loro::event::Diff;
use loro::{ExportMode, LoroDoc, VersionVector};

use crate::diffing::{content_hash, sync_from_disk};

/// A CRDT document backed by Loro.
pub struct SyncDocument {
    doc: LoroDoc,
    /// Version vector at the time of the last exported delta (for incremental exports).
    last_export_vv: VersionVector,
}

impl SyncDocument {
    pub fn new(_doc_uuid: impl Into<String>, _peer_id: impl Into<String>) -> Self {
        let doc = LoroDoc::new();
        let last_export_vv = doc.oplog_vv();
        Self {
            doc,
            last_export_vv,
        }
    }

    /// Insert text at `pos` (unicode char position).
    pub fn insert_text(&self, pos: usize, text: &str) -> Result<(), loro::LoroError> {
        self.doc.get_text("content").insert(pos, text)
    }

    /// Delete `len` chars starting at `pos`.
    pub fn delete_text(&self, pos: usize, len: usize) -> Result<(), loro::LoroError> {
        self.doc.get_text("content").delete(pos, len)
    }

    /// Get the current plaintext content.
    pub fn get_text(&self) -> String {
        self.doc.get_text("content").to_string()
    }

    /// Export a binary delta of all operations since `last_export_vv`.
    /// Advances the internal cursor so subsequent calls yield only new ops.
    pub fn export_delta(&mut self) -> Result<Vec<u8>, loro::LoroEncodeError> {
        let vv = self.last_export_vv.clone();
        let bytes = self.doc.export(ExportMode::updates(&vv))?;
        self.last_export_vv = self.doc.oplog_vv();
        Ok(bytes)
    }

    /// Import a binary delta (from another peer) and merge it.
    pub fn import_delta(&self, delta: &[u8]) -> Result<(), loro::LoroError> {
        self.doc.import(delta)?;
        Ok(())
    }

    /// Export a shallow snapshot of the current state.
    pub fn export_snapshot(&self) -> Result<Vec<u8>, loro::LoroEncodeError> {
        let frontiers = self.doc.state_frontiers();
        self.doc.export(ExportMode::shallow_snapshot(&frontiers))
    }

    /// Export a full snapshot including operation history.
    /// Required for server-side CRDT merge across independent peers.
    pub fn export_full_snapshot(&self) -> Result<Vec<u8>, loro::LoroEncodeError> {
        self.doc.export(ExportMode::Snapshot)
    }

    /// Current Loro version number (sum of all peer counters in the version vector).
    pub fn version(&self) -> u64 {
        self.doc.oplog_vv().iter().map(|(_, &c)| c as u64).sum()
    }

    /// Returns true if there are ops in the oplog that haven't been exported yet.
    pub fn has_pending_delta(&self) -> bool {
        self.last_export_vv != self.doc.oplog_vv()
    }

    // ── Batch import ──────────────────────────────────────────────────────

    /// Import multiple binary deltas in a single batch (more efficient than
    /// importing one at a time: single diff calc, one event emission).
    pub fn import_deltas_batch(&self, deltas: &[Vec<u8>]) -> Result<(), loro::LoroError> {
        self.doc.import_batch(deltas)?;
        Ok(())
    }

    // ── Cursor API (prep for Awareness / Remote Cursors) ─────────────────

    /// Get a stable cursor at the given character position.
    pub fn get_cursor(&self, pos: usize) -> Option<Cursor> {
        self.doc
            .get_text("content")
            .get_cursor(pos, Side::default())
    }

    /// Resolve a cursor to its current character position.
    pub fn resolve_cursor(&self, cursor: &Cursor) -> Result<usize, CannotFindRelativePosition> {
        self.doc.get_cursor_pos(cursor).map(|r| r.current.pos)
    }

    /// Apply an external disk change (diff against current Loro state).
    pub fn sync_from_disk(&self, new_disk_text: &str) {
        let current = self.get_text();
        sync_from_disk(&self.doc, &current, new_disk_text);
    }

    /// Export the version vector as a map of peer ID → counter.
    /// Used by the WASM layer for JSON serialization and by S32 delta-sync.
    pub fn export_vv(&self) -> HashMap<u64, i32> {
        self.doc.oplog_vv().iter().map(|(&k, &v)| (k, v)).collect()
    }

    /// Export ops since a given VV (provided as JSON string, e.g. `{"12345":47}`).
    pub fn export_updates_since_vv_json(&self, vv_json: &str) -> Result<Vec<u8>, DocumentError> {
        let map: HashMap<u64, i32> =
            serde_json::from_str(vv_json).map_err(|e| {
                DocumentError::Loro(loro::LoroError::DecodeError(e.to_string().into()))
            })?;
        let mut vv = VersionVector::new();
        for (peer, counter) in map {
            vv.insert(peer, counter);
        }
        self.doc
            .export(ExportMode::updates(&vv))
            .map_err(DocumentError::Encode)
    }

    /// Check if the CRDT text equals the given string without a JS roundtrip.
    pub fn text_matches(&self, text: &str) -> bool {
        self.get_text() == text
    }

    /// BLAKE3 hash of the current Loro text content.
    pub fn content_hash(&self) -> String {
        content_hash(&self.get_text())
    }

    /// Import a binary delta and return the text diff as a JSON string.
    ///
    /// Captures frontiers before import, imports the delta, then uses
    /// `doc.diff(before, after)` to extract the `TextDelta` ops.
    /// Returns a JSON array like `[{"retain":5},{"insert":"xyz"},{"delete":2}]`,
    /// or an empty string if nothing changed.
    pub fn import_and_diff(&self, delta: &[u8]) -> Result<String, DocumentError> {
        let frontiers_before = self.doc.state_frontiers();
        self.doc.import(delta).map_err(DocumentError::Loro)?;
        let frontiers_after = self.doc.state_frontiers();

        if frontiers_before == frontiers_after {
            return Ok(String::new());
        }

        let diff_batch = self.doc.diff(&frontiers_before, &frontiers_after)
            .map_err(DocumentError::Loro)?;

        for (_cid, diff) in diff_batch.iter() {
            if let Diff::Text(text_deltas) = diff {
                let json = serde_json::to_string(text_deltas)
                    .map_err(|e| DocumentError::Loro(loro::LoroError::DecodeError(e.to_string().into())))?;
                return Ok(json);
            }
        }

        Ok(String::new())
    }
}

#[derive(Debug)]
pub enum DocumentError {
    Loro(loro::LoroError),
    Encode(loro::LoroEncodeError),
}

impl std::fmt::Display for DocumentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Loro(e) => write!(f, "loro error: {e}"),
            Self::Encode(e) => write!(f, "loro encode error: {e}"),
        }
    }
}

impl std::error::Error for DocumentError {}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_doc(peer: &str) -> SyncDocument {
        SyncDocument::new("test-doc-uuid", peer)
    }

    #[test]
    fn test_two_peers_concurrent_edit() {
        let mut peer_a = make_doc("peer-a");
        let mut peer_b = make_doc("peer-b");

        peer_a.insert_text(0, "Hello").unwrap();
        peer_b.insert_text(0, "World").unwrap();

        let delta_a = peer_a.export_delta().unwrap();
        let delta_b = peer_b.export_delta().unwrap();

        peer_a.import_delta(&delta_b).unwrap();
        peer_b.import_delta(&delta_a).unwrap();

        // Both peers must converge to the same text (order may differ)
        assert_eq!(peer_a.get_text(), peer_b.get_text());
    }

    #[test]
    fn test_snapshot_and_incremental() {
        let mut peer_a = make_doc("peer-a");
        peer_a.insert_text(0, "Hello World").unwrap();

        let snapshot = peer_a.export_snapshot().unwrap();

        let peer_b = make_doc("peer-b");
        peer_b.import_delta(&snapshot).unwrap();
        assert_eq!(peer_b.get_text(), "Hello World");

        // Incremental update after snapshot
        peer_a.insert_text(11, "!").unwrap();
        let delta = peer_a.export_delta().unwrap();
        peer_b.import_delta(&delta).unwrap();

        assert_eq!(peer_b.get_text(), "Hello World!");
    }

    #[test]
    fn test_version_increments() {
        let doc = make_doc("peer");
        assert_eq!(doc.version(), 0, "new doc starts at version 0");

        doc.insert_text(0, "hello").unwrap();
        let v1 = doc.version();
        assert!(v1 > 0, "version must increase after insert");

        doc.insert_text(5, " world").unwrap();
        let v2 = doc.version();
        assert!(v2 > v1, "version must increase after second insert");
    }

    #[test]
    fn test_content_hash_changes_on_edit() {
        let doc = make_doc("peer");
        doc.insert_text(0, "initial").unwrap();
        let h1 = doc.content_hash();

        doc.insert_text(7, " text").unwrap();
        let h2 = doc.content_hash();

        assert_ne!(h1, h2);
    }

    #[test]
    fn test_import_batch_converges() {
        let mut peer_a = make_doc("peer-a");
        let mut peer_b = make_doc("peer-b");

        peer_a.insert_text(0, "AAA").unwrap();
        peer_b.insert_text(0, "BBB").unwrap();

        let delta_a = peer_a.export_delta().unwrap();
        let delta_b = peer_b.export_delta().unwrap();

        // Third peer imports both at once via batch
        let peer_c = make_doc("peer-c");
        peer_c
            .import_deltas_batch(&[delta_a.clone(), delta_b.clone()])
            .unwrap();

        // Sequential import for comparison
        let peer_d = make_doc("peer-d");
        peer_d.import_delta(&delta_a).unwrap();
        peer_d.import_delta(&delta_b).unwrap();

        assert_eq!(peer_c.get_text(), peer_d.get_text());
    }

    #[test]
    fn test_import_batch_equals_sequential() {
        let mut peer_a = make_doc("peer-a");
        peer_a.insert_text(0, "Hello").unwrap();
        let d1 = peer_a.export_delta().unwrap();

        peer_a.insert_text(5, " World").unwrap();
        let d2 = peer_a.export_delta().unwrap();

        let batch_doc = make_doc("batch");
        batch_doc.import_deltas_batch(&[d1.clone(), d2.clone()]).unwrap();

        let seq_doc = make_doc("seq");
        seq_doc.import_delta(&d1).unwrap();
        seq_doc.import_delta(&d2).unwrap();

        assert_eq!(batch_doc.get_text(), seq_doc.get_text());
        assert_eq!(batch_doc.get_text(), "Hello World");
    }

    #[test]
    fn test_cursor_survives_concurrent_edit() {
        let mut peer_a = make_doc("peer-a");
        peer_a.insert_text(0, "Hello World").unwrap();

        // Cursor at position 6 (start of "World")
        let cursor = peer_a.get_cursor(6).expect("cursor should exist");

        // Remote peer inserts text BEFORE the cursor position
        let mut peer_b = make_doc("peer-b");
        let delta_a = peer_a.export_delta().unwrap();
        peer_b.import_delta(&delta_a).unwrap();
        peer_b.insert_text(0, "Hey ").unwrap(); // "Hey Hello World"
        let delta_b = peer_b.export_delta().unwrap();

        peer_a.import_delta(&delta_b).unwrap();
        assert_eq!(peer_a.get_text(), "Hey Hello World");

        // Cursor should now point to position 10 ("World" shifted right by 4)
        let resolved = peer_a.resolve_cursor(&cursor).unwrap();
        assert_eq!(resolved, 10);
    }

    #[test]
    fn test_has_pending_delta() {
        let mut doc = make_doc("peer");
        assert!(!doc.has_pending_delta(), "new doc has no pending delta");

        doc.insert_text(0, "hello").unwrap();
        assert!(doc.has_pending_delta(), "pending after insert");

        let _ = doc.export_delta().unwrap();
        assert!(!doc.has_pending_delta(), "no pending after export");

        doc.insert_text(5, " world").unwrap();
        assert!(doc.has_pending_delta(), "pending after second insert");
    }

    /// Reproduce the offline-conflict bug: two peers independently create
    /// the same doc with different content, peer_b imports peer_a's snapshot
    /// then sync_from_disk with its own content. Server merges both snapshots.
    #[test]
    fn test_independent_peers_same_doc_different_content() {
        // vault-A creates E.md with "vault-a"
        let peer_a = make_doc("peer-a");
        peer_a.sync_from_disk("vault-a");
        let snapshot_a = peer_a.export_full_snapshot().unwrap();

        // vault-B imports server snapshot (peer-A's), then sync_from_disk with own content
        let peer_b = make_doc("peer-b");
        peer_b.import_delta(&snapshot_a).unwrap();
        assert_eq!(peer_b.get_text(), "vault-a");
        peer_b.sync_from_disk("vault-b");
        assert_eq!(peer_b.get_text(), "vault-b");
        let snapshot_b = peer_b.export_full_snapshot().unwrap();

        // Server-side merge: fresh doc imports both snapshots
        let server = LoroDoc::new();
        server.import(&snapshot_a).unwrap();
        server.import(&snapshot_b).unwrap();
        let merged_text = server.get_text("content").to_string();

        // peer_b's edit was causally AFTER peer_a's (peer_b imported a first),
        // so the merged result must be "vault-b"
        assert_eq!(merged_text, "vault-b");
    }

    /// Full E2E simulation including server re-export steps.
    /// This matches the exact flow: vault-A pushes → server stores → vault-B
    /// downloads → imports → sync_from_disk → pushes → server merges.
    #[test]
    fn test_full_server_roundtrip_merge() {
        // === vault-A: create E.md with "vault-a", push to server ===
        let vault_a = make_doc("vault-a-peer");
        vault_a.sync_from_disk("vault-a");
        let snapshot_a = vault_a.export_full_snapshot().unwrap();

        // === Server: first push (no existing doc) ===
        let server_doc1 = LoroDoc::new();
        server_doc1.import(&snapshot_a).unwrap();
        let server_stored = server_doc1.export(loro::ExportMode::Snapshot).unwrap();
        let server_text1 = server_doc1.get_text("content").to_string();
        assert_eq!(server_text1, "vault-a");

        // === vault-B: initialSync downloads server snapshot, then sync_from_disk ===
        let vault_b = make_doc("vault-b-peer");
        vault_b.import_delta(&server_stored).unwrap(); // import server's re-exported snapshot
        assert_eq!(vault_b.get_text(), "vault-a");
        vault_b.sync_from_disk("vault-b"); // diff "vault-a" → "vault-b"
        assert_eq!(vault_b.get_text(), "vault-b");
        let snapshot_b = vault_b.export_full_snapshot().unwrap();

        // === Server: second push (merge existing + client) ===
        let server_doc2 = LoroDoc::new();
        server_doc2.import(&server_stored).unwrap(); // existing
        server_doc2.import(&snapshot_b).unwrap(); // client
        let merged = server_doc2.export(loro::ExportMode::Snapshot).unwrap();
        let merged_text = server_doc2.get_text("content").to_string();

        assert_eq!(merged_text, "vault-b", "server merge must reflect vault-B's later edit");

        // === Verify: vault-A receives broadcast and converges ===
        vault_a.import_delta(&merged).unwrap();
        assert_eq!(vault_a.get_text(), "vault-b", "vault-A must converge to vault-B's content");
    }

    /// Scenario: both vaults push independently (local-only, no import of other's ops).
    /// This happens when both connect nearly simultaneously before the other's push arrives.
    /// Server merges two independent snapshots → concurrent inserts at pos 0.
    #[test]
    fn test_truly_concurrent_independent_creates() {
        // vault-A: fresh doc, sync "vault-a", export
        let vault_a = make_doc("vault-a-peer");
        vault_a.sync_from_disk("vault-a");
        let snapshot_a = vault_a.export_full_snapshot().unwrap();

        // vault-B: fresh doc, sync "vault-b", export (completely independent)
        let vault_b = make_doc("vault-b-peer");
        vault_b.sync_from_disk("vault-b");
        let snapshot_b = vault_b.export_full_snapshot().unwrap();

        // Server: first push from vault-A
        let server1 = LoroDoc::new();
        server1.import(&snapshot_a).unwrap();
        let stored_a = server1.export(loro::ExportMode::Snapshot).unwrap();

        // Server: second push from vault-B (merge with existing)
        let server2 = LoroDoc::new();
        server2.import(&stored_a).unwrap();
        server2.import(&snapshot_b).unwrap();
        let merged_text = server2.get_text("content").to_string();

        // With truly concurrent independent inserts, Loro concatenates rather than
        // replacing. This test documents the current CRDT behavior.
        println!("Truly concurrent merge result: {:?}", merged_text);
        // This will NOT be "vault-a" or "vault-b" alone — it will be concatenated
        assert!(
            merged_text.contains("vault-a") && merged_text.contains("vault-b"),
            "concurrent creates should contain both: got {:?}",
            merged_text
        );
    }

    #[test]
    fn test_export_vv() {
        let doc = make_doc("peer");
        let vv_empty = doc.export_vv();
        assert!(vv_empty.is_empty(), "new doc has empty VV");

        doc.insert_text(0, "hello").unwrap();
        let vv = doc.export_vv();
        assert_eq!(vv.len(), 1, "one peer in VV after insert");
        assert!(*vv.values().next().unwrap() > 0, "counter > 0 after insert");
    }

    #[test]
    fn test_text_matches() {
        let doc = make_doc("peer");
        assert!(doc.text_matches(""), "empty doc matches empty string");
        assert!(!doc.text_matches("x"), "empty doc does not match 'x'");

        doc.insert_text(0, "hello").unwrap();
        assert!(doc.text_matches("hello"), "matches inserted text");
        assert!(!doc.text_matches("world"), "does not match different text");
    }

    #[test]
    fn test_export_updates_since_vv_json() {
        let mut doc = make_doc("peer");
        doc.insert_text(0, "hello").unwrap();
        let vv_json = serde_json::to_string(&doc.export_vv()).unwrap();

        // Export a snapshot at "hello" state for doc2
        let snapshot = doc.export_delta().unwrap();

        doc.insert_text(5, " world").unwrap();
        let delta = doc.export_updates_since_vv_json(&vv_json).unwrap();
        assert!(!delta.is_empty());

        // doc2 imports snapshot (same ops as doc at "hello"), then applies delta
        let doc2 = make_doc("peer2");
        doc2.import_delta(&snapshot).unwrap();
        assert_eq!(doc2.get_text(), "hello");
        doc2.import_delta(&delta).unwrap();
        assert_eq!(doc2.get_text(), "hello world");
    }

    #[test]
    fn test_import_and_diff_insert() {
        let mut peer_a = make_doc("peer-a");
        let peer_b = make_doc("peer-b");

        peer_a.insert_text(0, "Hello").unwrap();
        let delta = peer_a.export_delta().unwrap();

        let diff_json = peer_b.import_and_diff(&delta).unwrap();
        let ops: Vec<serde_json::Value> = serde_json::from_str(&diff_json).unwrap();
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0]["insert"], "Hello");
    }

    #[test]
    fn test_import_and_diff_delete() {
        let mut peer_a = make_doc("peer-a");
        let peer_b = make_doc("peer-b");

        // Both start with "Hello World"
        peer_a.insert_text(0, "Hello World").unwrap();
        let snapshot = peer_a.export_delta().unwrap();
        peer_b.import_delta(&snapshot).unwrap();

        // peer_a deletes " World"
        peer_a.delete_text(5, 6).unwrap();
        let delta = peer_a.export_delta().unwrap();

        let diff_json = peer_b.import_and_diff(&delta).unwrap();
        let ops: Vec<serde_json::Value> = serde_json::from_str(&diff_json).unwrap();
        // Expect: retain 5, delete 6
        assert_eq!(ops.len(), 2);
        assert_eq!(ops[0]["retain"], 5);
        assert_eq!(ops[1]["delete"], 6);
    }

    #[test]
    fn test_import_and_diff_replace() {
        let mut peer_a = make_doc("peer-a");
        let peer_b = make_doc("peer-b");

        peer_a.insert_text(0, "Hello World").unwrap();
        let snapshot = peer_a.export_delta().unwrap();
        peer_b.import_delta(&snapshot).unwrap();

        // peer_a replaces "World" with "Rust"
        peer_a.delete_text(6, 5).unwrap();
        peer_a.insert_text(6, "Rust").unwrap();
        let delta = peer_a.export_delta().unwrap();

        let diff_json = peer_b.import_and_diff(&delta).unwrap();
        let ops: Vec<serde_json::Value> = serde_json::from_str(&diff_json).unwrap();
        assert!(!ops.is_empty());
        // Should contain retain, delete, and insert ops
        let has_insert = ops.iter().any(|o| o.get("insert").is_some());
        let has_delete = ops.iter().any(|o| o.get("delete").is_some());
        assert!(has_insert, "should have insert op");
        assert!(has_delete, "should have delete op");
        assert_eq!(peer_b.get_text(), "Hello Rust");
    }

    #[test]
    fn test_import_and_diff_no_change() {
        let peer_a = make_doc("peer-a");
        let peer_b = make_doc("peer-b");

        // Export empty delta (no ops)
        let snapshot = peer_a.export_snapshot().unwrap();
        let diff_json = peer_b.import_and_diff(&snapshot).unwrap();
        assert!(diff_json.is_empty(), "no-change should return empty string");
    }

    #[test]
    fn test_cursor_roundtrip_serde() {
        let doc = make_doc("peer");
        doc.insert_text(0, "Test cursor").unwrap();

        let cursor = doc.get_cursor(5).expect("cursor should exist");

        // Cursor implements Serialize + Deserialize
        let json = serde_json::to_string(&cursor).unwrap();
        let deserialized: loro::cursor::Cursor = serde_json::from_str(&json).unwrap();

        let pos = doc.resolve_cursor(&deserialized).unwrap();
        assert_eq!(pos, 5);
    }
}
