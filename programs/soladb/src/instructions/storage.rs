use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

use crate::constants::*;
use crate::error::SolaDbError;
use crate::events::*;
use crate::state::{segment_count, Chunk, ChunkState, Config, Identity, Replicator};

// ── open_chunk ──────────────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct OpenChunkArgs {
    /// sha256 of the full chunk
    pub content_hash: [u8; 32],
    /// Chunk length in bytes
    pub size: u32,
    /// Bytes per `write_segment` (the last one may be shorter)
    pub segment_size: u16,
    pub replicas: u8,
    /// Key allowed to write the segments (the owner or a session key)
    pub writer: Pubkey,
    /// Abort if the quote is above this many lamports
    pub max_fee: u64,
}

#[derive(Accounts)]
#[instruction(args: OpenChunkArgs)]
pub struct OpenChunk<'info> {
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
        space = Chunk::space(segment_count(args.size, args.segment_size), args.replicas),
        seeds = [CHUNK_SEED, owner.key().as_ref(), args.content_hash.as_ref()],
        bump,
    )]
    pub chunk: Account<'info, Chunk>,

    /// CHECK: receives the protocol fee; must be the configured treasury
    #[account(mut, dup, address = config.treasury @ SolaDbError::InvalidTreasury)]
    pub treasury: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Reserve a chunk and pay for it.  The protocol share goes to the treasury
/// and the replica rewards are escrowed in the chunk account itself.
pub fn handle_open_chunk(ctx: Context<OpenChunk>, args: OpenChunkArgs) -> Result<()> {
    require!(
        args.size > 0 && args.size <= MAX_CHUNK_SIZE,
        SolaDbError::InvalidSize
    );
    require!(
        (MIN_SEGMENT_SIZE..=MAX_SEGMENT_SIZE).contains(&args.segment_size),
        SolaDbError::InvalidSegmentSize
    );
    let segments = segment_count(args.size, args.segment_size);
    require!(segments <= MAX_SEGMENTS, SolaDbError::TooManySegments);
    require!(
        args.replicas >= 1 && args.replicas <= MAX_REPLICAS,
        SolaDbError::InvalidReplicas
    );

    let config = &ctx.accounts.config;
    let fee = config.quote(args.size, args.replicas)?;
    if fee > args.max_fee {
        msg!("upload fee {} lamports > max_fee {}", fee, args.max_fee);
        return err!(SolaDbError::FeeAboveMax);
    }
    let (protocol_fee, reward_per_replica) = config.split_fee(fee, args.replicas);
    let window = config.replication_window;

    let owner = ctx.accounts.owner.to_account_info();
    if protocol_fee > 0 {
        pay(
            &owner,
            &ctx.accounts.treasury.to_account_info(),
            protocol_fee,
        )?;
    }
    let escrow = reward_per_replica * args.replicas as u64;
    if escrow > 0 {
        pay(&owner, &ctx.accounts.chunk.to_account_info(), escrow)?;
    }

    let now = Clock::get()?.unix_timestamp;
    let chunk_key = ctx.accounts.chunk.key();
    let chunk = &mut ctx.accounts.chunk;
    chunk.owner = owner.key();
    chunk.content_hash = args.content_hash;
    chunk.writer = args.writer;
    chunk.state = ChunkState::Pending;
    chunk.needs_replicas = false;
    chunk.reclaimed = false;
    chunk.bump = ctx.bumps.chunk;
    chunk.required_replicas = args.replicas;
    chunk.confirmed_replicas = 0;
    chunk.segment_size = args.segment_size;
    chunk.segments_total = segments;
    chunk.segments_written = 0;
    chunk.size = args.size;
    chunk.reward_per_replica = reward_per_replica;
    chunk.opened_at = now;
    chunk.completed_at = 0;
    chunk.reclaimable_at = now + window;
    chunk.segments = vec![0; (segments as usize).div_ceil(8)];
    chunk.replicators = Vec::with_capacity(args.replicas as usize);

    emit!(ChunkOpened {
        chunk: chunk_key,
        owner: chunk.owner,
        content_hash: args.content_hash,
        size: args.size,
        required_replicas: args.replicas,
        fee,
        protocol_fee,
        reward_per_replica,
    });
    Ok(())
}

fn pay<'info>(from: &AccountInfo<'info>, to: &AccountInfo<'info>, lamports: u64) -> Result<()> {
    transfer(
        CpiContext::new(
            System::id(),
            Transfer {
                from: from.clone(),
                to: to.clone(),
            },
        ),
        lamports,
    )
}

// ── write_segment ───────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct WriteSegment<'info> {
    pub writer: Signer<'info>,

    #[account(mut, has_one = writer @ SolaDbError::NotWriter)]
    pub chunk: Account<'info, Chunk>,
}

/// Put segment `index` of the chunk in the ledger.  `data` is only checked
/// for its length and never stored: replicators read it back from this
/// instruction.  Each index can be written once, so every replicator
/// rebuilds the same bytes.
pub fn handle_write_segment(ctx: Context<WriteSegment>, index: u32, data: Vec<u8>) -> Result<()> {
    let chunk = &mut ctx.accounts.chunk;
    require!(
        chunk.state == ChunkState::Pending && !chunk.reclaimed,
        SolaDbError::ChunkNotPending
    );
    require!(
        index < chunk.segments_total,
        SolaDbError::InvalidSegmentIndex
    );
    require!(
        !chunk.segment_written(index),
        SolaDbError::SegmentAlreadyWritten
    );
    require!(
        data.len() as u32 == chunk.segment_len(index),
        SolaDbError::InvalidSegmentLength
    );

    chunk.mark_segment(index);
    chunk.segments_written += 1;

    if chunk.segments_written == chunk.segments_total {
        chunk.state = ChunkState::Hot;
        chunk.needs_replicas = true;
        chunk.completed_at = Clock::get()?.unix_timestamp;
        emit!(ChunkCompleted {
            chunk: ctx.accounts.chunk.key(),
            owner: ctx.accounts.chunk.owner,
            size: ctx.accounts.chunk.size,
        });
    }
    Ok(())
}

// ── confirm_replication ─────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct ConfirmReplication<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [REPLICATOR_SEED, authority.key().as_ref()],
        bump = replicator.bump,
        has_one = authority,
    )]
    pub replicator: Account<'info, Replicator>,

    #[account(mut)]
    pub chunk: Account<'info, Chunk>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
}

/// A replicator stored the chunk (and checked its sha256): it is paid its
/// reward from the chunk escrow right away.
pub fn handle_confirm_replication(ctx: Context<ConfirmReplication>) -> Result<()> {
    require!(
        ctx.accounts.replicator.active,
        SolaDbError::ReplicatorInactive
    );

    let authority = ctx.accounts.authority.key();
    let chunk = &mut ctx.accounts.chunk;
    require!(
        chunk.state != ChunkState::Pending,
        SolaDbError::ChunkIncomplete
    );
    require!(!chunk.reclaimed, SolaDbError::ReplicationClosed);
    require!(
        chunk.confirmed_replicas < chunk.required_replicas,
        SolaDbError::FullyReplicated
    );
    require!(
        !chunk.replicators.contains(&authority),
        SolaDbError::AlreadyReplicated
    );

    chunk.replicators.push(authority);
    chunk.confirmed_replicas += 1;
    if chunk.confirmed_replicas == chunk.required_replicas {
        chunk.needs_replicas = false;
    }

    let reward = chunk.reward_per_replica;
    if reward > 0 {
        chunk.sub_lamports(reward)?;
        ctx.accounts.authority.add_lamports(reward)?;
    }

    let replicator = &mut ctx.accounts.replicator;
    replicator.confirmations += 1;
    replicator.lamports_earned += reward;

    let chunk_key = ctx.accounts.chunk.key();
    let chunk = &mut ctx.accounts.chunk;
    emit!(ReplicationConfirmed {
        chunk: chunk_key,
        replicator: authority,
        reward,
        confirmed_replicas: chunk.confirmed_replicas,
        required_replicas: chunk.required_replicas,
    });

    let needed = ctx.accounts.config.cool_threshold(chunk.required_replicas);
    if chunk.state == ChunkState::Hot && chunk.confirmed_replicas >= needed {
        chunk.state = ChunkState::Cool;
        emit!(ChunkCooled {
            chunk: chunk_key,
            confirmed_replicas: chunk.confirmed_replicas,
        });
    }
    Ok(())
}

// ── reclaim_unreplicated / close_chunk ──────────────────────────────────────

#[derive(Accounts)]
pub struct OwnerChunk<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(mut, has_one = owner @ SolaDbError::NotOwner)]
    pub chunk: Account<'info, Chunk>,
}

/// After the replication window, recover the rewards of the replicas nobody
/// confirmed.  Closes the chunk to further confirmations.
pub fn handle_reclaim_unreplicated(ctx: Context<OwnerChunk>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let chunk = &mut ctx.accounts.chunk;
    require!(
        now >= chunk.reclaimable_at,
        SolaDbError::ReplicationWindowOpen
    );
    require!(!chunk.reclaimed, SolaDbError::ReplicationClosed);

    let missing = (chunk.required_replicas - chunk.confirmed_replicas) as u64;
    let amount = missing * chunk.reward_per_replica;
    require!(amount > 0, SolaDbError::NothingToClaim);

    chunk.reclaimed = true;
    chunk.needs_replicas = false;
    chunk.sub_lamports(amount)?;
    ctx.accounts.owner.add_lamports(amount)?;

    emit!(UnreplicatedReclaimed {
        chunk: ctx.accounts.chunk.key(),
        owner: ctx.accounts.owner.key(),
        amount,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct CloseChunk<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(mut, has_one = owner @ SolaDbError::NotOwner, close = owner)]
    pub chunk: Account<'info, Chunk>,
}

/// Close the chunk account and refund its rent plus any unspent escrow.
/// Allowed while the upload is still Pending (abort), once every replica is
/// confirmed, or after the replication window.  The data stays on the
/// replicators; readers verify it against the hash in their manifest.
pub fn handle_close_chunk(ctx: Context<CloseChunk>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let chunk = &ctx.accounts.chunk;
    require!(
        chunk.state == ChunkState::Pending
            || chunk.confirmed_replicas == chunk.required_replicas
            || now >= chunk.reclaimable_at,
        SolaDbError::ChunkNotSettled
    );
    emit!(ChunkClosed {
        chunk: chunk.key(),
        owner: chunk.owner,
    });
    Ok(())
}
