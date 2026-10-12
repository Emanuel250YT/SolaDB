use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::SolaDbError;
use crate::events::{ConfigUpdated, ReplicatorUpdated};
use crate::program::Soladb;
use crate::state::{Config, ConfigParams, Replicator};

// ── initialize ──────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, Config>,

    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ SolaDbError::InvalidProgramData)]
    pub program: Program<'info, Soladb>,

    /// Only the upgrade authority can create the configuration, so nobody can
    /// front-run the deployer between `deploy` and `initialize`.
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ SolaDbError::NotUpgradeAuthority)]
    pub program_data: Account<'info, ProgramData>,

    pub system_program: Program<'info, System>,
}

pub fn handle_initialize(ctx: Context<Initialize>, params: ConfigParams) -> Result<()> {
    params.validate()?;
    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.bump = ctx.bumps.config;
    config.apply(&params);
    emit_config(config);
    Ok(())
}

// ── update_config / transfer_admin ──────────────────────────────────────────

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
}

pub fn handle_update_config(ctx: Context<AdminOnly>, params: ConfigParams) -> Result<()> {
    params.validate()?;
    let config = &mut ctx.accounts.config;
    config.apply(&params);
    emit_config(config);
    Ok(())
}

pub fn handle_transfer_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
    require!(new_admin != Pubkey::default(), SolaDbError::ZeroAddress);
    let config = &mut ctx.accounts.config;
    config.admin = new_admin;
    emit_config(config);
    Ok(())
}

fn emit_config(config: &Config) {
    emit!(ConfigUpdated {
        admin: config.admin,
        treasury: config.treasury,
        base_fee_per_replica: config.base_fee_per_replica,
        price_per_byte: config.price_per_byte,
        protocol_fee_bps: config.protocol_fee_bps,
        replication_threshold_pct: config.replication_threshold_pct,
        replication_window: config.replication_window,
    });
}

// ── replicators ─────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct RegisterReplicator<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,

    /// CHECK: the node's wallet; any address can run a replicator
    pub authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + Replicator::INIT_SPACE,
        seeds = [REPLICATOR_SEED, authority.key().as_ref()],
        bump,
    )]
    pub replicator: Account<'info, Replicator>,

    pub system_program: Program<'info, System>,
}

pub fn handle_register_replicator(
    ctx: Context<RegisterReplicator>,
    endpoint: String,
) -> Result<()> {
    validate_endpoint(&endpoint)?;
    let replicator = &mut ctx.accounts.replicator;
    replicator.authority = ctx.accounts.authority.key();
    replicator.active = true;
    replicator.bump = ctx.bumps.replicator;
    replicator.registered_at = Clock::get()?.unix_timestamp;
    replicator.endpoint = endpoint;
    emit_replicator(replicator);
    Ok(())
}

#[derive(Accounts)]
pub struct SetReplicatorActive<'info> {
    pub admin: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,

    #[account(mut, seeds = [REPLICATOR_SEED, replicator.authority.as_ref()], bump = replicator.bump)]
    pub replicator: Account<'info, Replicator>,
}

pub fn handle_set_replicator_active(ctx: Context<SetReplicatorActive>, active: bool) -> Result<()> {
    let replicator = &mut ctx.accounts.replicator;
    replicator.active = active;
    emit_replicator(replicator);
    Ok(())
}

#[derive(Accounts)]
pub struct UpdateReplicatorEndpoint<'info> {
    pub authority: Signer<'info>,

    #[account(mut, seeds = [REPLICATOR_SEED, authority.key().as_ref()], bump = replicator.bump, has_one = authority)]
    pub replicator: Account<'info, Replicator>,
}

pub fn handle_update_replicator_endpoint(
    ctx: Context<UpdateReplicatorEndpoint>,
    endpoint: String,
) -> Result<()> {
    validate_endpoint(&endpoint)?;
    let replicator = &mut ctx.accounts.replicator;
    replicator.endpoint = endpoint;
    emit_replicator(replicator);
    Ok(())
}

fn validate_endpoint(endpoint: &str) -> Result<()> {
    require!(
        !endpoint.is_empty() && endpoint.len() <= MAX_ENDPOINT_LEN,
        SolaDbError::InvalidEndpoint
    );
    Ok(())
}

fn emit_replicator(replicator: &Replicator) {
    emit!(ReplicatorUpdated {
        authority: replicator.authority,
        active: replicator.active,
        endpoint: replicator.endpoint.clone(),
    });
}
