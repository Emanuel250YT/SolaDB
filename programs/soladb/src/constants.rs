//! Seeds and protocol bounds.

use anchor_lang::prelude::*;

pub const CONFIG_SEED: &[u8] = b"config";
pub const IDENTITY_SEED: &[u8] = b"identity";
pub const REPLICATOR_SEED: &[u8] = b"replicator";
pub const CHUNK_SEED: &[u8] = b"chunk";
pub const RECORD_SEED: &[u8] = b"record";
pub const GRANT_SEED: &[u8] = b"grant";
pub const BLOB_SEED: &[u8] = b"blob";

/// Upper bound for the replicas requested per chunk
pub const MAX_REPLICAS: u8 = 16;

/// Upper bound for the protocol share of an upload (30 %)
pub const MAX_PROTOCOL_FEE_BPS: u16 = 3_000;

/// Bounds for the replication window, in seconds
pub const MIN_REPLICATION_WINDOW: i64 = 3_600;
pub const MAX_REPLICATION_WINDOW: i64 = 90 * 86_400;

/// Largest chunk written to the ledger, in bytes
pub const MAX_CHUNK_SIZE: u32 = 1024 * 1024;

/// Largest direct chunk (bytes sent straight to replicators), in bytes
pub const MAX_DIRECT_CHUNK_SIZE: u32 = 16 * 1024 * 1024;

/// Seconds after which an unconfirmed direct chunk can be closed (failed upload)
pub const DIRECT_ABORT_DELAY: i64 = 600;

/// Pricing unit
pub const BYTES_PER_MIB: u64 = 1024 * 1024;

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

// ── Blobs (docs/blob-protocol.md) ───────────────────────────────────────────

/// Bytes per Merkle leaf of a shard, and per storage-proof answer
pub const SEGMENT_SIZE: u64 = 1_024;

/// Erasure-coded shards per blob (`n = k + m`)
pub const MAX_SHARDS: u8 = 32;

/// Largest shard (1 TiB)
pub const MAX_SHARD_SIZE: u64 = 1 << 40;

/// Longest prepaid storage, in epochs
pub const MAX_BLOB_EPOCHS: u32 = 1_200;

/// A challenge's randomness is the hash of a slot that does not exist yet
pub const CHALLENGE_DELAY_SLOTS: u64 = 2;

/// Answers must land while the challenge slot is still in SlotHashes (512 entries)
pub const MAX_CHALLENGE_WINDOW_SLOTS: u64 = 450;

/// Bounds for the storage epoch, in seconds
pub const MIN_EPOCH_SECONDS: i64 = 60;
pub const MAX_EPOCH_SECONDS: i64 = 366 * 86_400;

/// SlotHashes sysvar
pub const SLOT_HASHES_ID: Pubkey = pubkey!("SysvarS1otHashes111111111111111111111111111");
