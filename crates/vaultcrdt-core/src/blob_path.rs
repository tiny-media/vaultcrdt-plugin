//! Blob path key v1 — canonical, case-insensitive key for attachment paths.
//!
//! Frozen algorithm (`key_version = 1`, oracle: `docs/blob-path-key-vectors.json`):
//! structure gate → NFC → full casefold (CaseFolding C+F) → NFC.
//! Collisions are intentional (that is the point: `Übersicht.PNG` and the NFD
//! spelling of the same name must land on one key).

use caseless::default_case_fold_str;
use unicode_normalization::UnicodeNormalization;

/// Allowed attachment extensions (lowercased, without dot). Must stay in sync
/// with `ATTACHMENT_EXTENSIONS` in `src/path-policy.ts`.
pub const ATTACHMENT_EXTENSIONS: [&str; 15] = [
    "jpg", "jpeg", "png", "webp", "gif", "heic", "heif", "avif", "pdf", "mp3", "m4a", "ogg",
    "opus", "flac", "wav",
];

const BLOCKED_PREFIXES: [&str; 2] = [".obsidian/", ".trash/"];
const MAX_PATH_BYTES: usize = 1024;

/// Canonical key for a vault-relative attachment path, or `None` if the path is
/// not a syncable attachment path (fail-closed).
pub fn blob_path_key(path: &str) -> Option<String> {
    // Lone surrogates cannot survive the JS→Rust String boundary (and Rust `char`
    // cannot hold one); validate anyway against WTF-8/CESU-8 style byte sequences
    // ED A0 80 .. ED BF BF, which would encode U+D800..U+DFFF.
    if path.as_bytes().windows(2).any(|w| w[0] == 0xED && w[1] >= 0xA0) {
        return None;
    }
    if path.is_empty() || path.len() > MAX_PATH_BYTES || path.starts_with('/') {
        return None;
    }

    for seg in path.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return None;
        }
        if seg.ends_with(' ') || seg.ends_with('.') {
            return None;
        }
    }

    let file = path.rsplit('/').next()?;
    let ext = file.rsplit_once('.')?.1.to_lowercase();
    if !ATTACHMENT_EXTENSIONS.contains(&ext.as_str()) {
        return None;
    }

    let s1: String = path.nfc().collect();
    let s2 = default_case_fold_str(&s1);
    let key: String = s2.nfc().collect();

    // Blocked prefixes are compared on the FINAL key, so folded spellings
    // (`.Obsidian/`, `.OBSIDIAN/`) are caught too.
    if BLOCKED_PREFIXES.iter().any(|p| key.starts_with(p)) {
        return None;
    }

    Some(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vectors_from_json() {
        let raw = include_str!("../../../docs/blob-path-key-vectors.json");
        let doc: serde_json::Value = serde_json::from_str(raw).expect("valid vectors JSON");
        assert_eq!(doc["key_version"], 1);

        let mut accepted = 0;
        let mut rejected = 0;
        for v in doc["vectors"].as_array().expect("vectors array") {
            let input = v["input"].as_str().expect("input string");
            match v["key"].as_str() {
                Some(expected) => {
                    assert_eq!(
                        blob_path_key(input).as_deref(),
                        Some(expected),
                        "vector {input:?}"
                    );
                    accepted += 1;
                }
                None => {
                    assert_eq!(blob_path_key(input), None, "vector {input:?} must reject");
                    rejected += 1;
                }
            }
        }
        assert!(accepted >= 11 && rejected >= 9, "{accepted} accepted, {rejected} rejected");
    }

    #[test]
    fn intentional_collisions_and_separations() {
        let k = |s: &str| blob_path_key(s).unwrap();
        assert_eq!(k("Bilder/Übersicht.PNG"), k("Bilder/U\u{0308}bersicht.png"));
        assert_eq!(k("Notes/Straße.pdf"), k("Notes/STRASSE.pdf"));
        assert_ne!(k("İstanbul.jpg"), k("Istanbul.jpg"));
        assert_ne!(k("Ａｂｃ.png"), k("abc.png"));
    }

    #[test]
    fn key_is_idempotent_over_sampled_scalars() {
        let mut checked = 0;
        for cp in (0x0000u32..=0x2FFFF).step_by(97) {
            let Some(c) = char::from_u32(cp) else { continue }; // skips surrogates
            let input = format!("t/{c}/x.png");
            if let Some(key) = blob_path_key(&input) {
                assert_eq!(blob_path_key(&key).as_deref(), Some(key.as_str()), "cp U+{cp:04X}");
                checked += 1;
            }
        }
        assert!(checked > 1000, "sampled too few accepted paths: {checked}");
    }

    #[test]
    fn rejects_structural_violations() {
        for bad in [
            "../x.png",
            "/x.png",
            "a//b.png",
            "x.svg",
            "foo.png ",
            "a./x.png",
            ".obsidian/a.png",
            ".Obsidian/a.png",
            ".trash/a.png",
            "a/b/../c.png",
            "noext",
            "",
        ] {
            assert_eq!(blob_path_key(bad), None, "{bad:?} must reject");
        }
        let long = format!("{}.png", "a".repeat(1021));
        assert_eq!(long.len(), 1025);
        assert_eq!(blob_path_key(&long), None, "over 1024 bytes must reject");
        assert!(blob_path_key(&long[1..]).is_some(), "exactly 1024 bytes is fine");
    }
}

