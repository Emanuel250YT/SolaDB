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
    #[msg("Chunk size must be between 1 byte and 1 MiB")]
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
}
