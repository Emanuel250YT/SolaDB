//! SolaDB on Solana: private, replicated file storage.
//!
//! * **Identity**: each wallet publishes the X25519 key others seal data to.
//! * **Storage**: a file is split into encrypted chunks.  A chunk is opened
//!   (and paid for), then its bytes are written to the *ledger* in segments
//!   carried by `write_segment` instruction data.  Replicator nodes rebuild
//!   the chunk from those transactions, check its sha256, store it and call
//!   `confirm_replication`, which pays them from the chunk escrow.  Once
//!   enough replicas confirm, the chunk turns Cool.
//! * **Records**: the file manifest (chunk list + data key) is sealed to the
//!   owner's key and stored in a record; each reader gets a sealed copy in a
//!   grant account.
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;
use state::ConfigParams;

declare_id!("SoLA2LWHLmxARYxNKqtUaKMyttMwZ7WwnSHEgf47vu2");

#[program]
pub mod soladb {
    use super::*;

    // ── Admin ───────────────────────────────────────────────────────────────

    /// Create the configuration (upgrade authority only)
    pub fn initialize(ctx: Context<Initialize>, params: ConfigParams) -> Result<()> {
        instructions::admin::handle_initialize(ctx, params)
    }

    pub fn update_config(ctx: Context<AdminOnly>, params: ConfigParams) -> Result<()> {
        instructions::admin::handle_update_config(ctx, params)
    }

    pub fn transfer_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        instructions::admin::handle_transfer_admin(ctx, new_admin)
    }

    pub fn register_replicator(ctx: Context<RegisterReplicator>, endpoint: String) -> Result<()> {
        instructions::admin::handle_register_replicator(ctx, endpoint)
    }

    pub fn set_replicator_active(ctx: Context<SetReplicatorActive>, active: bool) -> Result<()> {
        instructions::admin::handle_set_replicator_active(ctx, active)
    }

    pub fn update_replicator_endpoint(
        ctx: Context<UpdateReplicatorEndpoint>,
        endpoint: String,
    ) -> Result<()> {
        instructions::admin::handle_update_replicator_endpoint(ctx, endpoint)
    }

    // ── Identity ────────────────────────────────────────────────────────────

    pub fn register_identity(
        ctx: Context<RegisterIdentity>,
        encryption_key: [u8; 32],
    ) -> Result<()> {
        instructions::identity::handle_register_identity(ctx, encryption_key)
    }

    pub fn update_identity(ctx: Context<UpdateIdentity>, encryption_key: [u8; 32]) -> Result<()> {
        instructions::identity::handle_update_identity(ctx, encryption_key)
    }

    // ── Storage ─────────────────────────────────────────────────────────────

    pub fn open_chunk(ctx: Context<OpenChunk>, args: OpenChunkArgs) -> Result<()> {
        instructions::storage::handle_open_chunk(ctx, args)
    }

    pub fn write_segment(ctx: Context<WriteSegment>, index: u32, data: Vec<u8>) -> Result<()> {
        instructions::storage::handle_write_segment(ctx, index, data)
    }

    pub fn confirm_replication(ctx: Context<ConfirmReplication>) -> Result<()> {
        instructions::storage::handle_confirm_replication(ctx)
    }

    pub fn reclaim_unreplicated(ctx: Context<OwnerChunk>) -> Result<()> {
        instructions::storage::handle_reclaim_unreplicated(ctx)
    }

    pub fn close_chunk(ctx: Context<CloseChunk>) -> Result<()> {
        instructions::storage::handle_close_chunk(ctx)
    }

    // ── Records ─────────────────────────────────────────────────────────────

    pub fn create_record(
        ctx: Context<CreateRecord>,
        schema: String,
        content: Vec<u8>,
    ) -> Result<()> {
        instructions::records::handle_create_record(ctx, schema, content)
    }

    pub fn update_record(ctx: Context<UpdateRecord>, content: Vec<u8>) -> Result<()> {
        instructions::records::handle_update_record(ctx, content)
    }

    pub fn delete_record(ctx: Context<DeleteRecord>) -> Result<()> {
        instructions::records::handle_delete_record(ctx)
    }

    pub fn grant_access(ctx: Context<GrantAccess>, content: Vec<u8>) -> Result<()> {
        instructions::records::handle_grant_access(ctx, content)
    }

    pub fn update_grant(ctx: Context<UpdateGrant>, content: Vec<u8>) -> Result<()> {
        instructions::records::handle_update_grant(ctx, content)
    }

    pub fn revoke_access(ctx: Context<RevokeAccess>) -> Result<()> {
        instructions::records::handle_revoke_access(ctx)
    }
}
