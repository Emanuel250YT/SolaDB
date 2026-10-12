use anchor_lang::prelude::*;

use crate::constants::IDENTITY_SEED;
use crate::events::IdentityRegistered;
use crate::state::Identity;

#[derive(Accounts)]
pub struct RegisterIdentity<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        init,
        payer = user,
        space = 8 + Identity::INIT_SPACE,
        seeds = [IDENTITY_SEED, user.key().as_ref()],
        bump,
    )]
    pub identity: Account<'info, Identity>,

    pub system_program: Program<'info, System>,
}

/// Publish the caller's X25519 public key.  The transaction signature already
/// proves control of the wallet, and a wrong key only hurts its owner (data
/// sealed to a key they cannot open), so no proof of possession is needed.
pub fn handle_register_identity(
    ctx: Context<RegisterIdentity>,
    encryption_key: [u8; 32],
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let identity = &mut ctx.accounts.identity;
    identity.user = ctx.accounts.user.key();
    identity.encryption_key = encryption_key;
    identity.registered_at = now;
    identity.updated_at = now;
    identity.record_nonce = 0;
    identity.bump = ctx.bumps.identity;
    emit!(IdentityRegistered {
        user: identity.user,
        encryption_key
    });
    Ok(())
}

#[derive(Accounts)]
pub struct UpdateIdentity<'info> {
    pub user: Signer<'info>,

    #[account(mut, seeds = [IDENTITY_SEED, user.key().as_ref()], bump = identity.bump)]
    pub identity: Account<'info, Identity>,
}

/// Rotate the caller's encryption key (records sealed to the old key must be
/// re-sealed by their owners)
pub fn handle_update_identity(
    ctx: Context<UpdateIdentity>,
    encryption_key: [u8; 32],
) -> Result<()> {
    let identity = &mut ctx.accounts.identity;
    identity.encryption_key = encryption_key;
    identity.updated_at = Clock::get()?.unix_timestamp;
    emit!(IdentityRegistered {
        user: identity.user,
        encryption_key
    });
    Ok(())
}
