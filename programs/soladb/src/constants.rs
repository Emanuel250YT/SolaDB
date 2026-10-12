//! Seeds and protocol bounds.

pub const CONFIG_SEED: &[u8] = b"config";
pub const IDENTITY_SEED: &[u8] = b"identity";
pub const REPLICATOR_SEED: &[u8] = b"replicator";
pub const CHUNK_SEED: &[u8] = b"chunk";
pub const RECORD_SEED: &[u8] = b"record";
pub const GRANT_SEED: &[u8] = b"grant";

/// Upper bound for the replicas requested per chunk
pub const MAX_REPLICAS: u8 = 16;

/// Upper bound for the protocol share of an upload (30 %)
pub const MAX_PROTOCOL_FEE_BPS: u16 = 3_000;

/// Bounds for the replication window, in seconds
pub const MIN_REPLICATION_WINDOW: i64 = 3_600;
pub const MAX_REPLICATION_WINDOW: i64 = 90 * 86_400;

/// Largest chunk, in bytes
pub const MAX_CHUNK_SIZE: u32 = 1024 * 1024;

/// Bounds for the bytes carried by one `write_segment` instruction.  A legacy
/// or v0 transaction fits ~900 bytes, a v1 transaction (4 KiB) ~3.8 KiB.
pub const MIN_SEGMENT_SIZE: u16 = 32;
pub const MAX_SEGMENT_SIZE: u16 = 4_000;

/// Largest number of segments per chunk (bitmap of 512 bytes)
pub const MAX_SEGMENTS: u32 = 4_096;

/// Longest replicator endpoint URL
pub const MAX_ENDPOINT_LEN: usize = 128;

/// Longest schema tag of a record
pub const MAX_SCHEMA_LEN: usize = 32;

/// Largest sealed content of a record or grant
pub const MAX_RECORD_CONTENT: usize = 2_048;
