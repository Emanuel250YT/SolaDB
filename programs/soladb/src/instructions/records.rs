use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::SolaDbError;
use crate::events::*;
use crate::state::{validate_content, Grant, Identity, Record};

// ── create_record ───────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(schema: String, content: Vec<u8>)]
pub struct CreateRecord<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(mut, seeds = [IDENTITY_SEED, owner.key().as_ref()], bump = identity.bump)]
    pub identity: Account<'info, Identity>,

    #[account(
        init,
        payer = owner,
        space = Record::space(schema.len(), content.len()),
        seeds = [RECORD_SEED, owner.key().as_ref(), &identity.record_nonce.to_le_bytes()],
        bump,
    )]
    pub record: Account<'info, Record>,

    pub system_program: Program<'info, System>,
}

/// Store `content` (sealed off-chain to the owner's key) in a new record
pub fn handle_create_record(
    ctx: Context<CreateRecord>,
    schema: String,
    content: Vec<u8>,
) -> Result<()> {
    require!(schema.len() <= MAX_SCHEMA_LEN, SolaDbError::InvalidSchema);
    validate_content(&content)?;

    let now = Clock::get()?.unix_timestamp;
    let identity = &mut ctx.accounts.identity;
    let nonce = identity.record_nonce;
    identity.record_nonce += 1;

    let record_key = ctx.accounts.record.key();
    let record = &mut ctx.accounts.record;
    record.owner = ctx.accounts.owner.key();
    record.nonce = nonce;
    record.created_at = now;
    record.updated_at = now;
    record.viewer_count = 0;
    record.bump = ctx.bumps.record;
    record.schema = schema.clone();
    record.content = content;

    emit!(RecordCreated {
        record: record_key,
        owner: record.owner,
        schema,
    });
    Ok(())
}

// ── update_record ───────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(content: Vec<u8>)]
pub struct UpdateRecord<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ SolaDbError::NotOwner,
        realloc = Record::space(record.schema.len(), content.len()),
        realloc::payer = owner,
        realloc::zero = false,
    )]
    pub record: Account<'info, Record>,

    pub system_program: Program<'info, System>,
}

/// Replace the owner's sealed content (grants keep their own copies)
pub fn handle_update_record(ctx: Context<UpdateRecord>, content: Vec<u8>) -> Result<()> {
    validate_content(&content)?;
    let record = &mut ctx.accounts.record;
    record.content = content;
    record.updated_at = Clock::get()?.unix_timestamp;
    emit!(RecordUpdated {
        record: record.key(),
        owner: record.owner,
    });
    Ok(())
}

// ── delete_record ───────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct DeleteRecord<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(mut, has_one = owner @ SolaDbError::NotOwner, close = owner)]
    pub record: Account<'info, Record>,
}

/// Close the record and refund its rent.  Viewers must be revoked first (the
/// SDK batches the revocations into the same transaction).
pub fn handle_delete_record(ctx: Context<DeleteRecord>) -> Result<()> {
    let record = &ctx.accounts.record;
    require!(record.viewer_count == 0, SolaDbError::RecordHasViewers);
    emit!(RecordDeleted {
        record: record.key(),
        owner: record.owner,
    });
    Ok(())
}

// ── grant_access / update_grant ─────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(content: Vec<u8>)]
pub struct GrantAccess<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(mut, has_one = owner @ SolaDbError::NotOwner)]
    pub record: Account<'info, Record>,

    /// The viewer must have published an encryption key
    #[account(seeds = [IDENTITY_SEED, viewer_identity.user.as_ref()], bump = viewer_identity.bump)]
    pub viewer_identity: Account<'info, Identity>,

    #[account(
        init,
        payer = owner,
        space = Grant::space(content.len()),
        seeds = [GRANT_SEED, record.key().as_ref(), viewer_identity.user.as_ref()],
        bump,
    )]
    pub grant: Account<'info, Grant>,

    pub system_program: Program<'info, System>,
}

/// Give a registered user its own copy of the record, sealed off-chain to the
/// viewer's encryption key
pub fn handle_grant_access(ctx: Context<GrantAccess>, content: Vec<u8>) -> Result<()> {
    validate_content(&content)?;
    let viewer = ctx.accounts.viewer_identity.user;
    let owner = ctx.accounts.owner.key();
    require!(viewer != owner, SolaDbError::CannotGrantSelf);

    let record_key = ctx.accounts.record.key();
    ctx.accounts.record.viewer_count += 1;

    let now = Clock::get()?.unix_timestamp;
    let grant = &mut ctx.accounts.grant;
    grant.record = record_key;
    grant.owner = owner;
    grant.viewer = viewer;
    grant.granted_at = now;
    grant.updated_at = now;
    grant.bump = ctx.bumps.grant;
    grant.content = content;

    emit!(AccessGranted {
        record: record_key,
        owner,
        viewer,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(content: Vec<u8>)]
pub struct UpdateGrant<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ SolaDbError::NotOwner,
        realloc = Grant::space(content.len()),
        realloc::payer = owner,
        realloc::zero = false,
    )]
    pub grant: Account<'info, Grant>,

    pub system_program: Program<'info, System>,
}

/// Replace a viewer's sealed copy (after the record content changed)
pub fn handle_update_grant(ctx: Context<UpdateGrant>, content: Vec<u8>) -> Result<()> {
    validate_content(&content)?;
    let grant = &mut ctx.accounts.grant;
    grant.content = content;
    grant.updated_at = Clock::get()?.unix_timestamp;
    emit!(AccessGranted {
        record: grant.record,
        owner: grant.owner,
        viewer: grant.viewer,
    });
    Ok(())
}

// ── revoke_access ───────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct RevokeAccess<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(mut, has_one = owner @ SolaDbError::NotOwner)]
    pub record: Account<'info, Record>,

    #[account(
        mut,
        has_one = owner @ SolaDbError::NotOwner,
        has_one = record @ SolaDbError::GrantMismatch,
        close = owner,
    )]
    pub grant: Account<'info, Grant>,
}

/// Delete a viewer's copy and refund its rent to the owner
pub fn handle_revoke_access(ctx: Context<RevokeAccess>) -> Result<()> {
    let record = &mut ctx.accounts.record;
    record.viewer_count -= 1;
    emit!(AccessRevoked {
        record: record.key(),
        owner: record.owner,
        viewer: ctx.accounts.grant.viewer,
    });
    Ok(())
}
