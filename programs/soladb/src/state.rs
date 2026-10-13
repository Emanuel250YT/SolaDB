use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::SolaDbError;

/// Protocol settings (PDA `["config"]`).
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    /// Receives the protocol share of every upload
    pub treasury: Pubkey,
    /// Flat fee per requested replica, in lamports (covers the confirmation)
    pub base_fee_per_replica: u64,
    /// Price per MiB per requested replica, in lamports (disk + bandwidth),
    /// charged pro rata to the byte
    pub price_per_mib: u64,
    /// Share of each upload kept by the protocol, in basis points
    pub protocol_fee_bps: u16,
    /// Percentage of the requested replicas that turns a chunk Cool
    pub replication_threshold_pct: u8,
    /// Seconds replicators have before the uploader can reclaim empty slots
    pub replication_window: i64,
    pub bump: u8,
    /// Blob storage is prepaid per epoch of this many seconds
    pub epoch_seconds: i64,
    /// Lamports per MiB of shard per epoch, charged pro rata to the byte
    pub price_per_mib_epoch: u64,
    /// Slots a holder has to answer a challenge after its target slot
    pub challenge_window_slots: u64,
    /// Seconds between two challenges of the same shard slot
    pub challenge_cooldown: i64,
    /// Share of forfeited rewards paid to whoever reports a failed challenge
    pub challenger_bounty_bps: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ConfigParams {
    pub treasury: Pubkey,
    pub base_fee_per_replica: u64,
    pub price_per_mib: u64,
    pub protocol_fee_bps: u16,
    pub replication_threshold_pct: u8,
    pub replication_window: i64,
    pub epoch_seconds: i64,
    pub price_per_mib_epoch: u64,
    pub challenge_window_slots: u64,
    pub challenge_cooldown: i64,
    pub challenger_bounty_bps: u16,
}

impl ConfigParams {
    pub fn validate(&self) -> Result<()> {
        require!(self.treasury != Pubkey::default(), SolaDbError::ZeroAddress);
        require!(
            self.protocol_fee_bps <= MAX_PROTOCOL_FEE_BPS,
            SolaDbError::InvalidParameter
        );
        require!(
            (1..=100).contains(&self.replication_threshold_pct),
            SolaDbError::InvalidParameter
        );
        require!(
            (MIN_REPLICATION_WINDOW..=MAX_REPLICATION_WINDOW).contains(&self.replication_window),
            SolaDbError::InvalidParameter
        );
        require!(
            (MIN_EPOCH_SECONDS..=MAX_EPOCH_SECONDS).contains(&self.epoch_seconds),
            SolaDbError::InvalidParameter
        );
        require!(
            (1..=MAX_CHALLENGE_WINDOW_SLOTS).contains(&self.challenge_window_slots),
            SolaDbError::InvalidParameter
        );
        require!(self.challenge_cooldown >= 0, SolaDbError::InvalidParameter);
        require!(
            self.challenger_bounty_bps <= 10_000,
            SolaDbError::InvalidParameter
        );
        Ok(())
    }
}

impl Config {
    pub fn apply(&mut self, params: &ConfigParams) {
        self.treasury = params.treasury;
        self.base_fee_per_replica = params.base_fee_per_replica;
        self.price_per_mib = params.price_per_mib;
        self.protocol_fee_bps = params.protocol_fee_bps;
        self.replication_threshold_pct = params.replication_threshold_pct;
        self.replication_window = params.replication_window;
        self.epoch_seconds = params.epoch_seconds;
        self.price_per_mib_epoch = params.price_per_mib_epoch;
        self.challenge_window_slots = params.challenge_window_slots;
        self.challenge_cooldown = params.challenge_cooldown;
        self.challenger_bounty_bps = params.challenger_bounty_bps;
    }

    /// Blob price: `n × (base_fee_per_replica + ⌈shard_size × price_per_mib_epoch × epochs / MiB⌉)`
    pub fn quote_blob(&self, shard_size: u64, total_shards: u8, epochs: u32) -> Result<u64> {
        let storage = (shard_size as u128)
            .checked_mul(self.price_per_mib_epoch as u128)
            .and_then(|v| v.checked_mul(epochs as u128))
            .map(|v| v.div_ceil(BYTES_PER_MIB as u128))
            .and_then(|v| u64::try_from(v).ok());
        storage
            .and_then(|v| v.checked_add(self.base_fee_per_replica))
            .and_then(|v| v.checked_mul(total_shards as u64))
            .ok_or_else(|| error!(SolaDbError::Overflow))
    }

    /// Upload price: `replicas × (base_fee_per_replica + ⌈size × price_per_mib / MiB⌉)`
    pub fn quote(&self, size: u32, replicas: u8) -> Result<u64> {
        let storage = (size as u128 * self.price_per_mib as u128).div_ceil(BYTES_PER_MIB as u128);
        u64::try_from(storage)
            .ok()
            .and_then(|v| v.checked_add(self.base_fee_per_replica))
            .and_then(|v| v.checked_mul(replicas as u64))
            .ok_or_else(|| error!(SolaDbError::Overflow))
    }

    /// Split a fee into (protocol share, reward per replica).  Rounding dust
    /// goes to the protocol.
    pub fn split_fee(&self, fee: u64, replicas: u8) -> (u64, u64) {
        let protocol = (fee as u128 * self.protocol_fee_bps as u128 / 10_000) as u64;
        let reward_per_replica = (fee - protocol) / replicas as u64;
        (
            fee - reward_per_replica * replicas as u64,
            reward_per_replica,
        )
    }

    /// Confirmations needed to turn a chunk Cool (at least one)
    pub fn cool_threshold(&self, required_replicas: u8) -> u8 {
        let needed = required_replicas as u16 * self.replication_threshold_pct as u16 / 100;
        needed.max(1) as u8
    }
}

/// Public X25519 key other users seal data to (PDA `["identity", user]`).
#[account]
#[derive(InitSpace)]
pub struct Identity {
    pub user: Pubkey,
    pub encryption_key: [u8; 32],
    pub registered_at: i64,
    pub updated_at: i64,
    /// Seeds the next record address of this user
    pub record_nonce: u64,
    pub bump: u8,
}

/// Storage node approved by the admin (PDA `["replicator", authority]`).
#[account]
#[derive(InitSpace)]
pub struct Replicator {
    pub authority: Pubkey,
    pub active: bool,
    pub bump: u8,
    pub registered_at: i64,
    pub confirmations: u64,
    pub lamports_earned: u64,
    /// HTTP endpoint that serves `/chunk/:id/data`
    #[max_len(MAX_ENDPOINT_LEN)]
    pub endpoint: String,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum ChunkState {
    /// Opened; segments are still being written to the ledger
    Pending,
    /// Complete and waiting for replicas: the bytes are in the ledger (ledger
    /// chunks) or with the replicators the uploader sent them to (direct chunks)
    Hot,
    /// Enough replicas confirmed; the ledger copy is no longer needed
    Cool,
}

/// One chunk of encrypted data (PDA `["chunk", owner, content_hash]`).
///
/// The bytes never live in account state.  A *ledger* chunk is written in
/// segments carried by `write_segment` instruction data, so the ledger holds
/// it while it is Hot.  A *direct* chunk (`segment_size == 0`) is sent by the
/// uploader straight to replicators, which check it against `content_hash`:
/// no segment transactions at all.  The account keeps the commitment
/// (sha256), the segment bitmap, the replicas that confirmed and the escrowed
/// rewards, and closes itself (rent back to the owner) once every replica
/// confirmed.
#[account]
pub struct Chunk {
    pub owner: Pubkey,
    /// sha256 of the full chunk; also the PDA seed
    pub content_hash: [u8; 32],
    /// Key allowed to write segments (the owner or a session key)
    pub writer: Pubkey,
    pub state: ChunkState,
    /// Complete, not reclaimed and still short of replicas (replicators filter on it)
    pub needs_replicas: bool,
    pub reclaimed: bool,
    pub bump: u8,
    pub required_replicas: u8,
    pub confirmed_replicas: u8,
    pub segment_size: u16,
    pub segments_total: u32,
    pub segments_written: u32,
    pub size: u32,
    /// Lamports escrowed in this account for each replica
    pub reward_per_replica: u64,
    pub opened_at: i64,
    pub completed_at: i64,
    pub reclaimable_at: i64,
    /// Bit `i` is set once segment `i` is in the ledger
    pub segments: Vec<u8>,
    /// Replicators that confirmed, in order
    pub replicators: Vec<Pubkey>,
}

/// Byte offsets used by off-chain `getProgramAccounts` filters
pub mod chunk_offsets {
    pub const OWNER: usize = 8;
    pub const STATE: usize = 104;
    pub const NEEDS_REPLICAS: usize = 105;
}

pub fn segment_count(size: u32, segment_size: u16) -> u32 {
    if segment_size == 0 {
        return 0;
    }
    size.div_ceil(segment_size as u32)
}

impl Chunk {
    /// Bytes go straight to replicators instead of the ledger
    pub fn is_direct(&self) -> bool {
        self.segment_size == 0
    }

    /// Account size; inputs are clamped so invalid arguments reach the handler checks
    pub fn space(segments: u32, replicas: u8) -> usize {
        let bitmap = (segments.min(MAX_SEGMENTS) as usize).div_ceil(8);
        let replicas = replicas.min(MAX_REPLICAS) as usize;
        8 + 32 * 3 + 6 + 2 + 4 * 3 + 8 * 4 + (4 + bitmap) + (4 + 32 * replicas)
    }

    pub fn segment_written(&self, index: u32) -> bool {
        self.segments[(index / 8) as usize] & (1 << (index % 8)) != 0
    }

    pub fn mark_segment(&mut self, index: u32) {
        self.segments[(index / 8) as usize] |= 1 << (index % 8);
    }

    /// Expected byte length of segment `index`
    pub fn segment_len(&self, index: u32) -> u32 {
        let start = index * self.segment_size as u32;
        (self.size - start).min(self.segment_size as u32)
    }
}

/// Encrypted record (PDA `["record", owner, nonce]`).  `content` is sealed
/// to the owner's encryption key; readers get their own copy in a Grant.
#[account]
pub struct Record {
    pub owner: Pubkey,
    pub nonce: u64,
    pub created_at: i64,
    pub updated_at: i64,
    pub viewer_count: u32,
    pub bump: u8,
    /// Unencrypted schema hint, e.g. `soladb.file.v2`
    pub schema: String,
    pub content: Vec<u8>,
}

impl Record {
    pub fn space(schema_len: usize, content_len: usize) -> usize {
        8 + 32 + 8 * 3 + 4 + 1 + (4 + schema_len) + (4 + content_len)
    }
}

/// A reader's copy of a record (PDA `["grant", record, viewer]`), sealed to
/// the viewer's encryption key.
#[account]
pub struct Grant {
    pub record: Pubkey,
    pub owner: Pubkey,
    pub viewer: Pubkey,
    pub granted_at: i64,
    pub updated_at: i64,
    pub bump: u8,
    pub content: Vec<u8>,
}

impl Grant {
    pub fn space(content_len: usize) -> usize {
        8 + 32 * 3 + 8 * 2 + 1 + (4 + content_len)
    }
}

pub fn validate_content(content: &[u8]) -> Result<()> {
    require!(
        !content.is_empty() && content.len() <= MAX_RECORD_CONTENT,
        SolaDbError::InvalidContent
    );
    Ok(())
}

// ── Blobs ────────────────────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum BlobState {
    /// Fewer than `data_shards` holders: not reconstructable from the nodes yet
    Hot,
    /// At least `data_shards` holders
    Cool,
}

/// One erasure-coded shard position of a blob
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, Debug, PartialEq, Eq)]
pub struct ShardSlot {
    /// Replicator holding the shard; the default key = vacant
    pub holder: Pubkey,
    /// Last successful storage proof (or the confirmation)
    pub proven_at: i64,
    /// Rewards are paid up to this time
    pub claimed_until: i64,
    pub last_challenge_at: i64,
    /// Slot whose hash picks the challenged segment; 0 = no open challenge
    pub challenge_slot: u64,
    /// Last slot to answer the open challenge
    pub challenge_deadline: u64,
}

impl ShardSlot {
    pub const SPACE: usize = 32 + 8 * 5;

    pub fn is_vacant(&self) -> bool {
        self.holder == Pubkey::default()
    }
}

/// An erasure-coded payload (PDA `["blob", owner, root]`), see
/// docs/blob-protocol.md.  One account per blob whatever its size: `root`
/// commits to every shard, nodes hold one shard each and are paid per epoch
/// once they prove they still have it.
#[account]
pub struct Blob {
    pub owner: Pubkey,
    /// Merkle root over the shard roots
    pub root: [u8; 32],
    pub state: BlobState,
    /// Some slot is vacant and the blob has not expired (nodes filter on it)
    pub needs_holders: bool,
    pub bump: u8,
    /// Shards needed to reconstruct (`k`)
    pub data_shards: u8,
    /// Shards stored (`n = k + m`)
    pub total_shards: u8,
    /// Slots with a holder
    pub held: u8,
    /// Bytes per shard, a multiple of SEGMENT_SIZE
    pub shard_size: u64,
    /// Encrypted payload bytes (informative)
    pub payload_size: u64,
    pub epochs: u32,
    /// Escrowed reward of one shard slot for one epoch
    pub reward_per_shard_epoch: u64,
    pub opened_at: i64,
    pub expires_at: i64,
    pub slots: Vec<ShardSlot>,
}

/// Byte offsets used by off-chain `getProgramAccounts` filters
pub mod blob_offsets {
    pub const OWNER: usize = 8;
    pub const STATE: usize = 72;
    pub const NEEDS_HOLDERS: usize = 73;
}

impl Blob {
    pub fn space(total_shards: u8) -> usize {
        8 + 32 * 2
            + 6
            + 8 * 2
            + 4
            + 8 * 3
            + 4
            + ShardSlot::SPACE * total_shards.min(MAX_SHARDS) as usize
    }

    /// Segments per shard (the Merkle leaves)
    pub fn shard_segments(&self) -> u64 {
        self.shard_size / SEGMENT_SIZE
    }

    /// Reward of one slot over `[from, to)`, prorated per second
    pub fn reward_between(&self, epoch_seconds: i64, from: i64, to: i64) -> u64 {
        if to <= from || epoch_seconds <= 0 {
            return 0;
        }
        (self.reward_per_shard_epoch as u128 * (to - from) as u128 / epoch_seconds as u128) as u64
    }

    pub fn refresh_flags(&mut self, now: i64) {
        self.state = if self.held >= self.data_shards {
            BlobState::Cool
        } else {
            BlobState::Hot
        };
        self.needs_holders = self.held < self.total_shards && now < self.expires_at;
    }
}

// ── Merkle proofs (docs/blob-protocol.md §2) ─────────────────────────────────

pub fn leaf_hash(segment: &[u8]) -> [u8; 32] {
    solana_sha256_hasher::hashv(&[&[0u8], segment]).to_bytes()
}

pub fn node_hash(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    solana_sha256_hasher::hashv(&[&[1u8], left, right]).to_bytes()
}

/// `ceil(log2(n))`, 0 for n ≤ 1
pub fn merkle_depth(n: u64) -> u32 {
    if n <= 1 {
        0
    } else {
        64 - (n - 1).leading_zeros()
    }
}

/// Walk `proof` (siblings bottom-up) from `node` at `index`
pub fn fold_proof(mut node: [u8; 32], index: u64, proof: &[[u8; 32]]) -> [u8; 32] {
    for (level, sibling) in proof.iter().enumerate() {
        node = if (index >> level) & 1 == 0 {
            node_hash(&node, sibling)
        } else {
            node_hash(sibling, &node)
        };
    }
    node
}
