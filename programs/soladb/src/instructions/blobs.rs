use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::SolaDbError;
use crate::events::*;
use crate::instructions::storage::pay;
use crate::state::{
    fold_proof, leaf_hash, merkle_depth, Blob, Config, Identity, Replicator, ShardSlot,
};

// ── open_blob ───────────────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct OpenBlobArgs {
    /// Merkle root over the shard roots (docs/blob-protocol.md §2)
    pub root: [u8; 32],
    /// Shards needed to reconstruct (`k`)
    pub data_shards: u8,
    /// Shards stored (`n = k + m`)
    pub total_shards: u8,
    /// Bytes per shard, a multiple of SEGMENT_SIZE
    pub shard_size: u64,
    /// Encrypted payload bytes (informative)
    pub payload_size: u64,
    /// Storage prepaid, in epochs of `config.epoch_seconds`
    pub epochs: u32,
    /// Abort if the quote is above this many lamports
    pub max_fee: u64,
}

#[derive(Accounts)]
#[instruction(args: OpenBlobArgs)]
pub struct OpenBlob<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    /// Uploaders must have published an encryption key
    #[account(seeds = [IDENTITY_SEED, owner.key().as_ref()], bump = identity.bump)]
    pub identity: Account<'info, Identity>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = owner,
        space = Blob::space(args.total_shards),
        seeds = [BLOB_SEED, owner.key().as_ref(), args.root.as_ref()],
        bump,
    )]
    pub blob: Account<'info, Blob>,

    /// CHECK: receives the protocol fee; must be the configured treasury
    #[account(mut, dup, address = config.treasury @ SolaDbError::InvalidTreasury)]
    pub treasury: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Reserve a blob and prepay its storage.  The protocol share goes to the
/// treasury; the rest is escrowed in the blob and paid to shard holders per
/// epoch, as they prove they still hold their shard.
pub fn handle_open_blob(ctx: Context<OpenBlob>, args: OpenBlobArgs) -> Result<()> {
    require!(
        args.data_shards >= 1
            && args.data_shards <= args.total_shards
            && args.total_shards <= MAX_SHARDS
            && args.shard_size > 0
            && args.shard_size.is_multiple_of(SEGMENT_SIZE)
            && args.shard_size <= MAX_SHARD_SIZE,
        SolaDbError::InvalidShardLayout
    );
    require!(
        args.epochs >= 1 && args.epochs <= MAX_BLOB_EPOCHS,
        SolaDbError::InvalidEpochs
    );
    let config = &ctx.accounts.config;
    require!(config.epoch_seconds > 0, SolaDbError::InvalidParameter);

    let fee = config.quote_blob(args.shard_size, args.total_shards, args.epochs)?;
    if fee > args.max_fee {
        msg!("blob fee {} lamports > max_fee {}", fee, args.max_fee);
        return err!(SolaDbError::FeeAboveMax);
    }
    let slot_epochs = args.total_shards as u64 * args.epochs as u64;
    let protocol = (fee as u128 * config.protocol_fee_bps as u128 / 10_000) as u64;
    let reward_per_shard_epoch = (fee - protocol) / slot_epochs;
    let escrow = reward_per_shard_epoch * slot_epochs;
    let protocol_fee = fee - escrow;

    let now = Clock::get()?.unix_timestamp;
    let expires_at = (args.epochs as i64)
        .checked_mul(config.epoch_seconds)
        .and_then(|v| v.checked_add(now))
        .ok_or_else(|| error!(SolaDbError::Overflow))?;

    let owner = ctx.accounts.owner.to_account_info();
    if protocol_fee > 0 {
        pay(
            &owner,
            &ctx.accounts.treasury.to_account_info(),
            protocol_fee,
        )?;
    }
    if escrow > 0 {
        pay(&owner, &ctx.accounts.blob.to_account_info(), escrow)?;
    }

    let blob_key = ctx.accounts.blob.key();
    let blob = &mut ctx.accounts.blob;
    blob.owner = owner.key();
    blob.root = args.root;
    blob.bump = ctx.bumps.blob;
    blob.data_shards = args.data_shards;
    blob.total_shards = args.total_shards;
    blob.held = 0;
    blob.shard_size = args.shard_size;
    blob.payload_size = args.payload_size;
    blob.epochs = args.epochs;
    blob.reward_per_shard_epoch = reward_per_shard_epoch;
    blob.opened_at = now;
    blob.expires_at = expires_at;
    blob.slots = vec![ShardSlot::default(); args.total_shards as usize];
    blob.refresh_flags(now);

    emit!(BlobOpened {
        blob: blob_key,
        owner: blob.owner,
        root: args.root,
        data_shards: args.data_shards,
        total_shards: args.total_shards,
        shard_size: args.shard_size,
        epochs: args.epochs,
        fee,
        protocol_fee,
        reward_per_shard_epoch,
    });
    Ok(())
}

// ── confirm_shard ───────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct ConfirmShard<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [REPLICATOR_SEED, authority.key().as_ref()],
        bump = replicator.bump,
        has_one = authority,
    )]
    pub replicator: Account<'info, Replicator>,

    #[account(mut)]
    pub blob: Account<'info, Blob>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
}

/// An active replicator stored shard `index` and checked it against the
/// blob root: it takes the slot.  Taking it opens a challenge right away, so
/// a node that confirms without the bytes cannot answer and loses the slot
/// within `challenge_window_slots` (no squatting).  Rewards accrue from now
/// and unlock as it answers challenges.
pub fn handle_confirm_shard(ctx: Context<ConfirmShard>, index: u8) -> Result<()> {
    require!(
        ctx.accounts.replicator.active,
        SolaDbError::ReplicatorInactive
    );
    let now = Clock::get()?.unix_timestamp;
    let authority = ctx.accounts.authority.key();
    let blob_key = ctx.accounts.blob.key();
    let blob = &mut ctx.accounts.blob;
    require!(index < blob.total_shards, SolaDbError::InvalidShardIndex);
    require!(now < blob.expires_at, SolaDbError::BlobExpired);
    require!(
        blob.slots[index as usize].is_vacant(),
        SolaDbError::SlotOccupied
    );
    require!(
        !blob.slots.iter().any(|s| s.holder == authority),
        SolaDbError::AlreadyHolder
    );

    let clock = Clock::get()?;
    let challenge_slot = clock.slot + CHALLENGE_DELAY_SLOTS;
    blob.slots[index as usize] = ShardSlot {
        holder: authority,
        proven_at: now,
        claimed_until: now,
        last_challenge_at: now,
        challenge_slot,
        challenge_deadline: challenge_slot + ctx.accounts.config.challenge_window_slots,
    };
    blob.held += 1;
    blob.refresh_flags(now);
    ctx.accounts.replicator.confirmations += 1;

    emit!(ShardConfirmed {
        blob: blob_key,
        index,
        holder: authority,
        held: blob.held,
    });
    Ok(())
}

// ── create_challenge ────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct CreateChallenge<'info> {
    pub challenger: Signer<'info>,

    #[account(mut)]
    pub blob: Account<'info, Blob>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
}

/// Ask the holder of shard `index` to prove it still has it.  The segment it
/// must answer with is picked by the hash of a slot that does not exist yet,
/// so neither side can choose it.
pub fn handle_create_challenge(ctx: Context<CreateChallenge>, index: u8) -> Result<()> {
    let clock = Clock::get()?;
    let config = &ctx.accounts.config;
    let blob_key = ctx.accounts.blob.key();
    let blob = &mut ctx.accounts.blob;
    require!(index < blob.total_shards, SolaDbError::InvalidShardIndex);
    // challenges stay possible one epoch past expiry, so holders can prove the last stretch
    require!(
        clock.unix_timestamp < blob.expires_at.saturating_add(config.epoch_seconds),
        SolaDbError::BlobExpired
    );
    let slot = &mut blob.slots[index as usize];
    require!(!slot.is_vacant(), SolaDbError::SlotVacant);
    require!(slot.challenge_slot == 0, SolaDbError::ChallengeOpen);
    require!(
        clock.unix_timestamp
            >= slot
                .last_challenge_at
                .saturating_add(config.challenge_cooldown),
        SolaDbError::ChallengeCooldown
    );

    slot.challenge_slot = clock.slot + CHALLENGE_DELAY_SLOTS;
    slot.challenge_deadline = slot.challenge_slot + config.challenge_window_slots;
    slot.last_challenge_at = clock.unix_timestamp;

    emit!(ShardChallenged {
        blob: blob_key,
        index,
        holder: slot.holder,
        challenge_slot: slot.challenge_slot,
        deadline: slot.challenge_deadline,
    });
    Ok(())
}

// ── prove_shard ─────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct ProveShard<'info> {
    pub prover: Signer<'info>,

    #[account(mut)]
    pub blob: Account<'info, Blob>,

    /// CHECK: the SlotHashes sysvar, read directly (too large to deserialize)
    #[account(address = SLOT_HASHES_ID)]
    pub slot_hashes: UncheckedAccount<'info>,
}

/// Answer the open challenge of shard `index` with the challenged 1 KiB
/// segment and its Merkle path to the blob root.  Only someone holding the
/// shard's bytes can do it.
pub fn handle_prove_shard(
    ctx: Context<ProveShard>,
    index: u8,
    segment: Vec<u8>,
    shard_proof: Vec<[u8; 32]>,
    top_proof: Vec<[u8; 32]>,
) -> Result<()> {
    let clock = Clock::get()?;
    let blob_key = ctx.accounts.blob.key();
    let blob = &mut ctx.accounts.blob;
    require!(index < blob.total_shards, SolaDbError::InvalidShardIndex);
    let slot = blob.slots[index as usize];
    require!(!slot.is_vacant(), SolaDbError::SlotVacant);
    require!(slot.challenge_slot != 0, SolaDbError::NoChallenge);
    require!(
        clock.slot > slot.challenge_slot,
        SolaDbError::ChallengeNotReady
    );
    require!(
        clock.slot <= slot.challenge_deadline,
        SolaDbError::ChallengeExpired
    );
    require!(
        segment.len() as u64 == SEGMENT_SIZE,
        SolaDbError::InvalidSegment
    );

    // A leader may skip the challenge slot: its randomness is then the first
    // produced slot after it, the same for everyone
    let slot_hash = match SlotHashesView::new(&ctx.accounts.slot_hashes)?
        .first_at_or_after(slot.challenge_slot)?
    {
        Some((_, hash)) => hash,
        None => return err!(SolaDbError::ChallengeNotReady),
    };
    let segments = blob.shard_segments();
    let seed = solana_sha256_hasher::hashv(&[&slot_hash, blob_key.as_ref(), &[index]]).to_bytes();
    let segment_index = u64::from_le_bytes(seed[..8].try_into().unwrap()) % segments;

    require!(
        shard_proof.len() as u32 == merkle_depth(segments)
            && top_proof.len() as u32 == merkle_depth(blob.total_shards as u64),
        SolaDbError::InvalidProof
    );
    let shard_root = fold_proof(leaf_hash(&segment), segment_index, &shard_proof);
    let root = fold_proof(shard_root, index as u64, &top_proof);
    require!(root == blob.root, SolaDbError::InvalidProof);

    let slot = &mut blob.slots[index as usize];
    slot.proven_at = clock.unix_timestamp;
    slot.challenge_slot = 0;
    slot.challenge_deadline = 0;

    emit!(ShardProven {
        blob: blob_key,
        index,
        holder: slot.holder,
        segment: segment_index,
    });
    Ok(())
}

/// The SlotHashes sysvar data, read in place: `u64 len`, then
/// `(u64 slot, [u8; 32] hash)` entries, newest first.  Skipped slots have no
/// entry.
struct SlotHashesView<'a> {
    data: core::cell::Ref<'a, &'a mut [u8]>,
    len: usize,
}

impl<'a> SlotHashesView<'a> {
    fn new(sysvar: &'a AccountInfo) -> Result<Self> {
        let data = sysvar.try_borrow_data()?;
        let len = data
            .get(..8)
            .map(|b| u64::from_le_bytes(b.try_into().unwrap()) as usize)
            .ok_or_else(|| error!(SolaDbError::SlotHashUnavailable))?;
        Ok(Self { data, len })
    }

    fn entry(&self, i: usize) -> Result<(u64, [u8; 32])> {
        let at = 8 + i * 40;
        let bytes = self
            .data
            .get(at..at + 40)
            .ok_or_else(|| error!(SolaDbError::SlotHashUnavailable))?;
        Ok((
            u64::from_le_bytes(bytes[..8].try_into().unwrap()),
            bytes[8..].try_into().unwrap(),
        ))
    }

    /// The oldest entry whose slot is ≥ `slot`, i.e. the first produced slot
    /// at or after it (None when no such slot is recorded yet)
    fn first_at_or_after(&self, slot: u64) -> Result<Option<(u64, [u8; 32])>> {
        // entries descend: find the last index whose slot is ≥ `slot`
        let (mut lo, mut hi) = (0usize, self.len);
        while lo < hi {
            let mid = (lo + hi) / 2;
            if self.entry(mid)?.0 >= slot {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        if lo == 0 {
            return Ok(None);
        }
        Ok(Some(self.entry(lo - 1)?))
    }

    /// A challenge on `start` could be answered by `deadline`: a produced slot
    /// `p1 ≥ start` gives the hash, and a later produced slot `p2 ≤ deadline`
    /// is a block the proof could land in (it sees `p1` in SlotHashes)
    fn answerable(&self, start: u64, deadline: u64) -> Result<bool> {
        // entries descend: `at` = how many have a slot ≥ start
        let (mut lo, mut hi) = (0usize, self.len);
        while lo < hi {
            let mid = (lo + hi) / 2;
            if self.entry(mid)?.0 >= start {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        if lo < 2 {
            return Ok(false);
        }
        // the oldest slot ≥ start, then the next newer one
        Ok(self.entry(lo - 2)?.0 <= deadline)
    }

    /// Oldest slot still recorded
    fn oldest(&self) -> Result<Option<u64>> {
        if self.len == 0 {
            return Ok(None);
        }
        Ok(Some(self.entry(self.len - 1)?.0))
    }
}

// ── fail_challenge ──────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct FailChallenge<'info> {
    #[account(mut)]
    pub reporter: Signer<'info>,

    #[account(mut)]
    pub blob: Account<'info, Blob>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    /// CHECK: the SlotHashes sysvar, read directly (too large to deserialize)
    #[account(address = SLOT_HASHES_ID)]
    pub slot_hashes: UncheckedAccount<'info>,
}

/// The holder of shard `index` let a challenge expire: it loses the slot and
/// its unclaimed rewards (a share goes to whoever reports it).  The slot
/// reopens, so another node can rebuild the shard from the others.  If
/// SlotHashes shows the window never allowed an answer (no block giving the
/// hash, or no later block before the deadline to carry the proof), the
/// challenge is voided instead, with no penalty and no bounty.
pub fn handle_fail_challenge(ctx: Context<FailChallenge>, index: u8) -> Result<()> {
    let clock = Clock::get()?;
    let config = &ctx.accounts.config;
    let blob_key = ctx.accounts.blob.key();
    let blob = &mut ctx.accounts.blob;
    require!(index < blob.total_shards, SolaDbError::InvalidShardIndex);
    let slot = blob.slots[index as usize];
    require!(!slot.is_vacant(), SolaDbError::SlotVacant);
    require!(slot.challenge_slot != 0, SolaDbError::NoChallenge);
    require!(
        clock.slot > slot.challenge_deadline,
        SolaDbError::ChallengeStillOpen
    );

    let hashes = SlotHashesView::new(&ctx.accounts.slot_hashes)?;
    let covered = hashes
        .oldest()?
        .is_some_and(|oldest| oldest <= slot.challenge_slot);
    let answerable = hashes.answerable(slot.challenge_slot, slot.challenge_deadline)?;
    if covered && !answerable {
        let slot = &mut blob.slots[index as usize];
        slot.challenge_slot = 0;
        slot.challenge_deadline = 0;
        emit!(ChallengeVoided {
            blob: blob_key,
            index,
            holder: slot.holder,
        });
        return Ok(());
    }

    let until = clock.unix_timestamp.min(blob.expires_at);
    let forfeited = blob.reward_between(config.epoch_seconds, slot.claimed_until, until);
    let bounty = (forfeited as u128 * config.challenger_bounty_bps as u128 / 10_000) as u64;

    blob.slots[index as usize] = ShardSlot::default();
    blob.held -= 1;
    blob.refresh_flags(clock.unix_timestamp);
    if bounty > 0 {
        blob.sub_lamports(bounty)?;
        ctx.accounts.reporter.add_lamports(bounty)?;
    }

    emit!(ShardLost {
        blob: blob_key,
        index,
        holder: slot.holder,
        forfeited,
        bounty,
    });
    Ok(())
}

// ── claim_shard_rewards ─────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct ClaimShardRewards<'info> {
    #[account(mut)]
    pub holder: Signer<'info>,

    #[account(
        mut,
        seeds = [REPLICATOR_SEED, holder.key().as_ref()],
        bump = replicator.bump,
        constraint = replicator.authority == holder.key() @ SolaDbError::NotHolder,
    )]
    pub replicator: Account<'info, Replicator>,

    #[account(mut)]
    pub blob: Account<'info, Blob>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
}

/// Pay the holder of shard `index` what it earned up to its last storage
/// proof (never past expiry).
pub fn handle_claim_shard_rewards(ctx: Context<ClaimShardRewards>, index: u8) -> Result<()> {
    let config = &ctx.accounts.config;
    let holder = ctx.accounts.holder.key();
    let blob_key = ctx.accounts.blob.key();
    let blob = &mut ctx.accounts.blob;
    require!(index < blob.total_shards, SolaDbError::InvalidShardIndex);
    let slot = blob.slots[index as usize];
    require!(slot.holder == holder, SolaDbError::NotHolder);

    let until = slot.proven_at.min(blob.expires_at);
    let amount = blob.reward_between(config.epoch_seconds, slot.claimed_until, until);
    require!(amount > 0, SolaDbError::NothingToClaim);

    blob.slots[index as usize].claimed_until = until;
    blob.sub_lamports(amount)?;
    ctx.accounts.holder.add_lamports(amount)?;
    ctx.accounts.replicator.lamports_earned += amount;

    emit!(ShardRewardsClaimed {
        blob: blob_key,
        index,
        holder,
        amount,
    });
    Ok(())
}

// ── extend_blob / close_blob ────────────────────────────────────────────────

#[derive(Accounts)]
pub struct ExtendBlob<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(mut, has_one = owner @ SolaDbError::NotOwner)]
    pub blob: Account<'info, Blob>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    /// CHECK: receives the protocol fee; must be the configured treasury
    #[account(mut, dup, address = config.treasury @ SolaDbError::InvalidTreasury)]
    pub treasury: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Prepay more epochs at the blob's own reward rate.
pub fn handle_extend_blob(ctx: Context<ExtendBlob>, epochs: u32, max_fee: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let config = &ctx.accounts.config;
    let blob = &ctx.accounts.blob;
    require!(
        epochs >= 1 && blob.epochs.saturating_add(epochs) <= MAX_BLOB_EPOCHS,
        SolaDbError::InvalidEpochs
    );
    require!(now < blob.expires_at, SolaDbError::BlobExpired);

    let escrow = blob
        .reward_per_shard_epoch
        .checked_mul(blob.total_shards as u64 * epochs as u64)
        .ok_or_else(|| error!(SolaDbError::Overflow))?;
    let protocol_fee = (escrow as u128 * config.protocol_fee_bps as u128
        / (10_000 - config.protocol_fee_bps) as u128) as u64;
    let fee = escrow + protocol_fee;
    if fee > max_fee {
        msg!("extension fee {} lamports > max_fee {}", fee, max_fee);
        return err!(SolaDbError::FeeAboveMax);
    }
    let added = (epochs as i64)
        .checked_mul(config.epoch_seconds)
        .ok_or_else(|| error!(SolaDbError::Overflow))?;

    let owner = ctx.accounts.owner.to_account_info();
    if protocol_fee > 0 {
        pay(
            &owner,
            &ctx.accounts.treasury.to_account_info(),
            protocol_fee,
        )?;
    }
    if escrow > 0 {
        pay(&owner, &ctx.accounts.blob.to_account_info(), escrow)?;
    }

    let blob_key = ctx.accounts.blob.key();
    let blob = &mut ctx.accounts.blob;
    blob.epochs += epochs;
    blob.expires_at += added;
    blob.refresh_flags(now);
    emit!(BlobExtended {
        blob: blob_key,
        epochs: blob.epochs,
        expires_at: blob.expires_at,
        fee,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct CloseBlob<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(mut, has_one = owner @ SolaDbError::NotOwner, close = owner)]
    pub blob: Account<'info, Blob>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
}

/// Close the blob and recover its rent plus unspent escrow: one epoch after
/// expiry (holders' grace to claim), or when nobody holds a shard and the
/// upload is more than DIRECT_ABORT_DELAY old (a failed upload).
pub fn handle_close_blob(ctx: Context<CloseBlob>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let blob = &ctx.accounts.blob;
    let expired = now
        >= blob
            .expires_at
            .saturating_add(ctx.accounts.config.epoch_seconds);
    let abandoned = blob.held == 0 && now >= blob.opened_at + DIRECT_ABORT_DELAY;
    require!(expired || abandoned, SolaDbError::BlobNotClosable);
    emit!(BlobClosed {
        blob: blob.key(),
        owner: blob.owner,
    });
    Ok(())
}
