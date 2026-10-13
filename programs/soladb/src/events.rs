use anchor_lang::prelude::*;

#[event]
pub struct ConfigUpdated {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub base_fee_per_replica: u64,
    pub price_per_mib: u64,
    pub protocol_fee_bps: u16,
    pub replication_threshold_pct: u8,
    pub replication_window: i64,
    pub epoch_seconds: i64,
    pub price_per_mib_epoch: u64,
}

#[event]
pub struct ReplicatorUpdated {
    pub authority: Pubkey,
    pub active: bool,
    pub endpoint: String,
}

#[event]
pub struct IdentityRegistered {
    pub user: Pubkey,
    pub encryption_key: [u8; 32],
}

#[event]
pub struct ChunkOpened {
    pub chunk: Pubkey,
    pub owner: Pubkey,
    pub content_hash: [u8; 32],
    pub size: u32,
    pub required_replicas: u8,
    pub fee: u64,
    pub protocol_fee: u64,
    pub reward_per_replica: u64,
}

#[event]
pub struct ChunkCompleted {
    pub chunk: Pubkey,
    pub owner: Pubkey,
    pub size: u32,
}

#[event]
pub struct ReplicationConfirmed {
    pub chunk: Pubkey,
    pub replicator: Pubkey,
    pub reward: u64,
    pub confirmed_replicas: u8,
    pub required_replicas: u8,
}

#[event]
pub struct ChunkCooled {
    pub chunk: Pubkey,
    pub confirmed_replicas: u8,
}

#[event]
pub struct UnreplicatedReclaimed {
    pub chunk: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct ChunkClosed {
    pub chunk: Pubkey,
    pub owner: Pubkey,
}

#[event]
pub struct RecordCreated {
    pub record: Pubkey,
    pub owner: Pubkey,
    pub schema: String,
}

#[event]
pub struct RecordUpdated {
    pub record: Pubkey,
    pub owner: Pubkey,
}

#[event]
pub struct RecordDeleted {
    pub record: Pubkey,
    pub owner: Pubkey,
}

#[event]
pub struct AccessGranted {
    pub record: Pubkey,
    pub owner: Pubkey,
    pub viewer: Pubkey,
}

#[event]
pub struct AccessRevoked {
    pub record: Pubkey,
    pub owner: Pubkey,
    pub viewer: Pubkey,
}

#[event]
pub struct BlobOpened {
    pub blob: Pubkey,
    pub owner: Pubkey,
    pub root: [u8; 32],
    pub data_shards: u8,
    pub total_shards: u8,
    pub shard_size: u64,
    pub epochs: u32,
    pub fee: u64,
    pub protocol_fee: u64,
    pub reward_per_shard_epoch: u64,
}

#[event]
pub struct ShardConfirmed {
    pub blob: Pubkey,
    pub index: u8,
    pub holder: Pubkey,
    pub held: u8,
}

#[event]
pub struct ShardChallenged {
    pub blob: Pubkey,
    pub index: u8,
    pub holder: Pubkey,
    pub challenge_slot: u64,
    pub deadline: u64,
}

#[event]
pub struct ShardProven {
    pub blob: Pubkey,
    pub index: u8,
    pub holder: Pubkey,
    pub segment: u64,
}

#[event]
pub struct ShardLost {
    pub blob: Pubkey,
    pub index: u8,
    pub holder: Pubkey,
    pub forfeited: u64,
    pub bounty: u64,
}

#[event]
pub struct ShardRewardsClaimed {
    pub blob: Pubkey,
    pub index: u8,
    pub holder: Pubkey,
    pub amount: u64,
}

#[event]
pub struct BlobExtended {
    pub blob: Pubkey,
    pub epochs: u32,
    pub expires_at: i64,
    pub fee: u64,
}

#[event]
pub struct BlobClosed {
    pub blob: Pubkey,
    pub owner: Pubkey,
}
