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
    /// Price per byte per requested replica, in lamports (disk + bandwidth)
    pub price_per_byte: u64,
    /// Share of each upload kept by the protocol, in basis points
    pub protocol_fee_bps: u16,
    /// Percentage of the requested replicas that turns a chunk Cool
    pub replication_threshold_pct: u8,
    /// Seconds replicators have before the uploader can reclaim empty slots
    pub replication_window: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ConfigParams {
    pub treasury: Pubkey,
    pub base_fee_per_replica: u64,
    pub price_per_byte: u64,
    pub protocol_fee_bps: u16,
    pub replication_threshold_pct: u8,
    pub replication_window: i64,
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
        Ok(())
    }
}

impl Config {
    pub fn apply(&mut self, params: &ConfigParams) {
        self.treasury = params.treasury;
        self.base_fee_per_replica = params.base_fee_per_replica;
        self.price_per_byte = params.price_per_byte;
        self.protocol_fee_bps = params.protocol_fee_bps;
        self.replication_threshold_pct = params.replication_threshold_pct;
        self.replication_window = params.replication_window;
    }

    /// Upload price: `replicas × (base_fee_per_replica + size × price_per_byte)`
    pub fn quote(&self, size: u32, replicas: u8) -> Result<u64> {
        (size as u64)
            .checked_mul(self.price_per_byte)
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
    /// Every segment is in the ledger; waiting for replicas
    Hot,
    /// Enough replicas confirmed; the ledger copy is no longer needed
    Cool,
}

/// One chunk of encrypted data (PDA `["chunk", owner, content_hash]`).
///
/// The bytes never live in account state: each `write_segment` carries a
/// slice in its instruction data, so the ledger holds the chunk while it is
/// Hot.  The account keeps the commitment (sha256), the segment bitmap, the
/// replicas that confirmed and the escrowed rewards.
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
