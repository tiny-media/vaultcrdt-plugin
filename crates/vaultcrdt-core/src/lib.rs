use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Unique identifier for a document (stable across peers).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct DocumentUUID(pub Uuid);

impl DocumentUUID {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }

    pub fn parse(s: &str) -> Result<Self, uuid::Error> {
        Ok(Self(Uuid::parse_str(s)?))
    }

    pub fn as_str(&self) -> String {
        self.0.to_string()
    }
}

impl Default for DocumentUUID {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for DocumentUUID {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Identifier for a peer (device).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PeerID(pub String);

impl PeerID {
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for PeerID {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Loro frontier version number.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Version(pub u64);

impl Version {
    pub fn new(v: u64) -> Self {
        Self(v)
    }

    pub fn value(&self) -> u64 {
        self.0
    }
}

impl std::fmt::Display for Version {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// An encrypted CRDT payload ready for transport/storage.
///
/// Wire format: `[4B version][12B nonce][NB ciphertext][16B tag]`
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncryptedPayload {
    pub doc_uuid: DocumentUUID,
    pub peer_id: PeerID,
    pub version: Version,
    /// Raw bytes in the payload wire format.
    pub blob: Vec<u8>,
}

impl EncryptedPayload {
    pub fn new(doc_uuid: DocumentUUID, peer_id: PeerID, version: Version, blob: Vec<u8>) -> Self {
        Self { doc_uuid, peer_id, version, blob }
    }

    /// Returns the AAD string used for AES-GCM authentication.
    pub fn aad(&self) -> String {
        format!("{}:{}:{}", self.doc_uuid, self.version, self.peer_id)
    }
}
