use anchor_lang::prelude::*;

#[error_code]
pub enum SolaDbError {
    // ── Admin ──────────────────────────────────────────────
    #[msg("Program data account does not belong to this program")]
    InvalidProgramData,
    #[msg("Only the program upgrade authority can initialize SolaDB")]
    NotUpgradeAuthority,
    #[msg("A configuration value is out of range")]
    InvalidParameter,
    #[msg("Address must not be the default public key")]
    ZeroAddress,
    #[msg("Endpoint is empty or longer than 128 bytes")]
    InvalidEndpoint,

    // ── Storage ────────────────────────────────────────────
    #[msg("Treasury account does not match the configuration")]
    InvalidTreasury,
    #[msg("Chunk size must be between 1 byte and 1 MiB (16 MiB for direct chunks)")]
    InvalidSize,
    #[msg("Segment size must be between 32 and 4000 bytes")]
    InvalidSegmentSize,
    #[msg("Chunk would have more than 4096 segments")]
    TooManySegments,
    #[msg("Replicas must be between 1 and 16")]
    InvalidReplicas,
    #[msg("Upload fee is above the max_fee the uploader accepted")]
    FeeAboveMax,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Signer is not the chunk writer")]
    NotWriter,
    #[msg("Chunk is no longer accepting segments")]
    ChunkNotPending,
    #[msg("Segment index out of range")]
    InvalidSegmentIndex,
    #[msg("Segment was already written")]
    SegmentAlreadyWritten,
    #[msg("Segment length does not match the chunk layout")]
    InvalidSegmentLength,
    #[msg("Replicator is not active")]
    ReplicatorInactive,
    #[msg("Chunk is still being written")]
    ChunkIncomplete,
    #[msg("Replicator already confirmed this chunk")]
    AlreadyReplicated,
    #[msg("Chunk already has all its replicas")]
    FullyReplicated,
    #[msg("Uploader closed this chunk to new replicas")]
    ReplicationClosed,
    #[msg("Replication window is still open")]
    ReplicationWindowOpen,
    #[msg("Nothing to reclaim")]
    NothingToClaim,
    #[msg("Chunk still owes replicas inside its replication window")]
    ChunkNotSettled,

    // ── Records ────────────────────────────────────────────
    #[msg("Signer is not the owner")]
    NotOwner,
    #[msg("Content is empty or longer than 2048 bytes")]
    InvalidContent,
    #[msg("Schema is longer than 32 bytes")]
    InvalidSchema,
    #[msg("Owner cannot grant access to itself")]
    CannotGrantSelf,
    #[msg("Revoke every viewer before deleting the record")]
    RecordHasViewers,
    #[msg("Grant does not belong to this record")]
    GrantMismatch,

    // ── Storage (appended to keep earlier codes stable) ────
    #[msg("Account is not the chunk owner")]
    InvalidChunkOwner,

    // ── Blobs ──────────────────────────────────────────────
    #[msg("Shards must be 1 ≤ k ≤ n ≤ 32 and the shard size a positive multiple of 1024 bytes")]
    InvalidShardLayout,
    #[msg("Epochs must be between 1 and 1200")]
    InvalidEpochs,
    #[msg("Shard index out of range")]
    InvalidShardIndex,
    #[msg("This shard slot already has a holder")]
    SlotOccupied,
    #[msg("This shard slot has no holder")]
    SlotVacant,
    #[msg("Signer is not the holder of this shard")]
    NotHolder,
    #[msg("This replicator already holds a shard of the blob")]
    AlreadyHolder,
    #[msg("The blob has expired")]
    BlobExpired,
    #[msg("The blob has not expired yet")]
    BlobNotExpired,
    #[msg("A challenge is already open on this shard")]
    ChallengeOpen,
    #[msg("This shard was challenged too recently")]
    ChallengeCooldown,
    #[msg("No open challenge on this shard")]
    NoChallenge,
    #[msg("The challenge slot has not been produced yet")]
    ChallengeNotReady,
    #[msg("The challenge deadline has passed")]
    ChallengeExpired,
    #[msg("The challenge deadline has not passed yet")]
    ChallengeStillOpen,
    #[msg("The challenge slot is no longer in SlotHashes")]
    SlotHashUnavailable,
    #[msg("Storage proof does not match the blob root")]
    InvalidProof,
    #[msg("A storage proof answers with one 1024-byte segment")]
    InvalidSegment,
    #[msg("The blob still has holders or is inside its abort delay")]
    BlobNotClosable,
}
