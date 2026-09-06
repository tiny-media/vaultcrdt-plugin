use blake3::Hasher;
use loro::LoroDoc;
use similar::{ChangeTag, TextDiff};

/// Compute the BLAKE3 hash of a string. Returns a 64-character hex string.
pub fn content_hash(text: &str) -> String {
    let mut hasher = Hasher::new();
    hasher.update(text.as_bytes());
    hasher.finalize().to_hex().to_string()
}

/// Apply the diff between `current_text` (what Loro thinks the text is)
/// and `new_disk_text` (what is on disk) into the Loro document.
///
/// Uses `from_words` for texts > 1 KB and `from_chars` for shorter texts
/// to reduce the number of Loro operations.
pub fn sync_from_disk(loro_doc: &LoroDoc, current_text: &str, new_disk_text: &str) {
    let text = loro_doc.get_text("content");

    if current_text.len() > 1024 {
        // Word-level diff: each token is a `&str`
        let diff = TextDiff::from_words(current_text, new_disk_text);
        let mut pos: usize = 0;
        for change in diff.iter_all_changes() {
            let token: &str = change.value();
            let char_len = token.chars().count();
            match change.tag() {
                ChangeTag::Equal => {
                    pos += char_len;
                }
                ChangeTag::Delete => {
                    text.delete(pos, char_len).expect("loro delete should not fail");
                }
                ChangeTag::Insert => {
                    text.insert(pos, token).expect("loro insert should not fail");
                    pos += char_len;
                }
            }
        }
    } else {
        // Char-level diff: each token is a single-char `&str`
        let diff = TextDiff::from_chars(current_text, new_disk_text);
        let mut pos: usize = 0;
        for change in diff.iter_all_changes() {
            let token: &str = change.value();
            let char_len = token.chars().count();
            match change.tag() {
                ChangeTag::Equal => {
                    pos += char_len;
                }
                ChangeTag::Delete => {
                    text.delete(pos, char_len).expect("loro delete should not fail");
                }
                ChangeTag::Insert => {
                    text.insert(pos, token).expect("loro insert should not fail");
                    pos += char_len;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use loro::LoroDoc;

    fn doc_with_text(content: &str) -> LoroDoc {
        let doc = LoroDoc::new();
        doc.get_text("content").insert(0, content).unwrap();
        doc
    }

    #[test]
    fn test_disk_append() {
        let doc = doc_with_text("Hello");
        let current = doc.get_text("content").to_string();

        sync_from_disk(&doc, &current, "Hello World");

        assert_eq!(doc.get_text("content").to_string(), "Hello World");
    }

    #[test]
    fn test_disk_edit_middle() {
        let doc = doc_with_text("Hello World");
        let current = doc.get_text("content").to_string();

        sync_from_disk(&doc, &current, "Hello Rust");

        assert_eq!(doc.get_text("content").to_string(), "Hello Rust");
    }

    #[test]
    fn test_disk_no_change() {
        let doc = doc_with_text("No change here");
        let current = doc.get_text("content").to_string();
        let hash_before = content_hash(&current);

        sync_from_disk(&doc, &current, &current);

        let after = doc.get_text("content").to_string();
        assert_eq!(after, current);
        assert_eq!(content_hash(&after), hash_before);
    }

    #[test]
    fn test_hash_changes() {
        let text1 = "Hello World";
        let text2 = "Hello Rust";
        assert_ne!(content_hash(text1), content_hash(text2));
    }

    #[test]
    fn test_hash_is_deterministic() {
        let text = "deterministic hashing";
        assert_eq!(content_hash(text), content_hash(text));
    }

    /// Helper: apply sync_from_disk and return the number of Loro ops generated
    fn ops_for_sync(base: &str, modified: &str) -> u64 {
        let doc = doc_with_text(base);
        let current = doc.get_text("content").to_string();
        // ops from initial insert
        let before: u64 = doc.oplog_vv().iter().map(|(_, &c)| c as u64).sum();
        sync_from_disk(&doc, &current, modified);
        assert_eq!(doc.get_text("content").to_string(), modified);
        let after: u64 = doc.oplog_vv().iter().map(|(_, &c)| c as u64).sum();
        after - before
    }

    #[test]
    fn test_threshold_boundary_char_vs_word_diff() {
        // "ab " repeated → has word boundaries (spaces).
        // Char-diff and word-diff produce different op counts for the same transformation.
        // We test at exactly the boundary: 1024 (char) vs 1025 (word).

        // 1024 bytes → must use char diff (not >1024)
        // "ab ".repeat(341) = 1023 bytes, add "a" to get 1024
        let base_at = format!("{}a", "ab ".repeat(341));
        assert_eq!(base_at.len(), 1024);
        let mod_at: String = base_at.replace("ab ", "ba ");
        let ops_at_1024 = ops_for_sync(&base_at, &mod_at);

        // 1025 bytes → must use word diff (>1024)
        let base_above = format!("{}x", &base_at);
        assert_eq!(base_above.len(), 1025);
        let mod_above: String = base_above.replace("ab ", "ba ");
        let ops_at_1025 = ops_for_sync(&base_above, &mod_above);

        // With correct threshold: 1024 uses char diff, 1025 uses word diff → different op counts.
        // Snapshot the exact values so any mutant that changes the threshold is caught.
        // If the mutant changes > to ==, >= or <, at least one value changes.
        assert_eq!(ops_at_1024, 682, "1024B must use char-diff");
        assert_eq!(ops_at_1025, 1364, "1025B must use word-diff");
    }

    #[test]
    fn test_large_text_uses_words() {
        // Text > 1 KB triggers word-level diff
        let base = "word ".repeat(300); // ~1500 chars
        let modified = format!("INSERTED {}", base);
        let doc = doc_with_text(&base);
        let current = doc.get_text("content").to_string();

        sync_from_disk(&doc, &current, &modified);

        assert_eq!(doc.get_text("content").to_string(), modified);
    }
}
