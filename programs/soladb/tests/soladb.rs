//! Program tests on LiteSVM: admin, identity, chunk economics and records.
//!
//! Build first (`anchor build`), then `cargo test -p soladb`.
#![allow(clippy::result_large_err)]

use {
    anchor_lang::{
        prelude::{Clock, Pubkey},
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    litesvm::{types::TransactionResult, LiteSVM},
    sha2::{Digest, Sha256},
    soladb::{
        constants::*,
        error::SolaDbError,
        instructions::OpenChunkArgs,
        state::{Chunk, ChunkState, Config, ConfigParams, Grant, Identity, Record, Replicator},
    },
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

const SOL: u64 = 1_000_000_000;
const BASE_FEE: u64 = 20_000;
const PRICE_PER_BYTE: u64 = 2;
const WINDOW: i64 = 7 * 86_400;

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    treasury: Pubkey,
}

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &soladb::id()).0
}
fn config_pda() -> Pubkey {
    pda(&[CONFIG_SEED])
}
fn identity_pda(user: &Pubkey) -> Pubkey {
    pda(&[IDENTITY_SEED, user.as_ref()])
}
fn replicator_pda(authority: &Pubkey) -> Pubkey {
    pda(&[REPLICATOR_SEED, authority.as_ref()])
}
fn chunk_pda(owner: &Pubkey, hash: &[u8; 32]) -> Pubkey {
    pda(&[CHUNK_SEED, owner.as_ref(), hash])
}
fn record_pda(owner: &Pubkey, nonce: u64) -> Pubkey {
    pda(&[RECORD_SEED, owner.as_ref(), &nonce.to_le_bytes()])
}
fn grant_pda(record: &Pubkey, viewer: &Pubkey) -> Pubkey {
    pda(&[GRANT_SEED, record.as_ref(), viewer.as_ref()])
}
fn program_data_pda() -> Pubkey {
    let loader: Pubkey = "BPFLoaderUpgradeab1e11111111111111111111111"
        .parse()
        .unwrap();
    Pubkey::find_program_address(&[soladb::id().as_ref()], &loader).0
}

/// System program transfer (instruction 2)
fn transfer_ix(from: &Pubkey, to: &Pubkey, lamports: u64) -> Instruction {
    use anchor_lang::solana_program::instruction::AccountMeta;
    let mut data = vec![2, 0, 0, 0];
    data.extend_from_slice(&lamports.to_le_bytes());
    Instruction::new_with_bytes(
        system_program::ID,
        &data,
        vec![AccountMeta::new(*from, true), AccountMeta::new(*to, false)],
    )
}

fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

fn ix(data: impl InstructionData, accounts: impl ToAccountMetas) -> Instruction {
    Instruction::new_with_bytes(soladb::id(), &data.data(), accounts.to_account_metas(None))
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let bytes = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/soladb.so"));
        svm.add_program(soladb::id(), bytes).unwrap();

        let admin = Keypair::new();
        svm.airdrop(&admin.pubkey(), 100 * SOL).unwrap();

        // LiteSVM deploys without an upgrade authority: make `admin` the authority
        let address = program_data_pda();
        let mut account = svm.get_account(&address).unwrap();
        account.data[12] = 1;
        account.data[13..45].copy_from_slice(admin.pubkey().as_ref());
        svm.set_account(address, account).unwrap();

        let treasury = Keypair::new().pubkey();
        svm.airdrop(&treasury, SOL).unwrap();

        let mut clock: Clock = svm.get_sysvar();
        clock.unix_timestamp = 1_760_000_000;
        svm.set_sysvar(&clock);

        let mut env = Env {
            svm,
            admin,
            treasury,
        };
        env.initialize(&env.admin.insecure_clone(), env.params())
            .unwrap();
        env
    }

    fn params(&self) -> ConfigParams {
        ConfigParams {
            treasury: self.treasury,
            base_fee_per_replica: BASE_FEE,
            price_per_byte: PRICE_PER_BYTE,
            protocol_fee_bps: 1_000,
            replication_threshold_pct: 60,
            replication_window: WINDOW,
        }
    }

    fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> TransactionResult {
        self.svm.expire_blockhash();
        let payer = signers[0].pubkey();
        let msg = Message::new_with_blockhash(ixs, Some(&payer), &self.svm.latest_blockhash());
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
        self.svm.send_transaction(tx)
    }

    fn fetch<T: AccountDeserialize>(&self, address: &Pubkey) -> T {
        let account = self.svm.get_account(address).expect("account exists");
        T::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

    fn exists(&self, address: &Pubkey) -> bool {
        self.svm
            .get_account(address)
            .is_some_and(|a| a.lamports > 0)
    }

    fn balance(&self, address: &Pubkey) -> u64 {
        self.svm.get_balance(address).unwrap_or(0)
    }

    fn user(&mut self) -> Keypair {
        let user = Keypair::new();
        self.svm.airdrop(&user.pubkey(), 10 * SOL).unwrap();
        user
    }

    fn warp(&mut self, seconds: i64) {
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp += seconds;
        clock.slot += 1;
        self.svm.set_sysvar(&clock);
    }

    // ── instruction helpers ────────────────────────────────────────────────

    fn initialize(&mut self, admin: &Keypair, params: ConfigParams) -> TransactionResult {
        let ix = ix(
            soladb::instruction::Initialize { params },
            soladb::accounts::Initialize {
                admin: admin.pubkey(),
                config: config_pda(),
                program: soladb::id(),
                program_data: program_data_pda(),
                system_program: system_program::ID,
            },
        );
        self.send(&[ix], &[admin])
    }

    fn register_identity(&mut self, user: &Keypair) -> TransactionResult {
        let ix = ix(
            soladb::instruction::RegisterIdentity {
                encryption_key: [7; 32],
            },
            soladb::accounts::RegisterIdentity {
                user: user.pubkey(),
                identity: identity_pda(&user.pubkey()),
                system_program: system_program::ID,
            },
        );
        self.send(&[ix], &[user])
    }

    fn registered_user(&mut self) -> Keypair {
        let user = self.user();
        self.register_identity(&user).unwrap();
        user
    }

    fn register_replicator(&mut self, authority: &Pubkey, endpoint: &str) -> TransactionResult {
        let admin = self.admin.insecure_clone();
        let ix = ix(
            soladb::instruction::RegisterReplicator {
                endpoint: endpoint.into(),
            },
            soladb::accounts::RegisterReplicator {
                admin: admin.pubkey(),
                config: config_pda(),
                authority: *authority,
                replicator: replicator_pda(authority),
                system_program: system_program::ID,
            },
        );
        self.send(&[ix], &[&admin])
    }

    fn replicator(&mut self) -> Keypair {
        let node = self.user();
        self.register_replicator(&node.pubkey(), "http://node.example:3000")
            .unwrap();
        node
    }

    fn open_chunk_ix(
        &self,
        owner: &Pubkey,
        data: &[u8],
        segment_size: u16,
        replicas: u8,
        writer: Pubkey,
    ) -> Instruction {
        let content_hash = sha256(data);
        ix(
            soladb::instruction::OpenChunk {
                args: OpenChunkArgs {
                    content_hash,
                    size: data.len() as u32,
                    segment_size,
                    replicas,
                    writer,
                    max_fee: u64::MAX,
                },
            },
            soladb::accounts::OpenChunk {
                owner: *owner,
                identity: identity_pda(owner),
                config: config_pda(),
                chunk: chunk_pda(owner, &content_hash),
                treasury: self.treasury,
                system_program: system_program::ID,
            },
        )
    }

    fn open_chunk(
        &mut self,
        owner: &Keypair,
        data: &[u8],
        segment_size: u16,
        replicas: u8,
    ) -> Pubkey {
        let ix = self.open_chunk_ix(
            &owner.pubkey(),
            data,
            segment_size,
            replicas,
            owner.pubkey(),
        );
        self.send(&[ix], &[owner]).unwrap();
        chunk_pda(&owner.pubkey(), &sha256(data))
    }

    fn write_segment(
        &mut self,
        writer: &Keypair,
        chunk: &Pubkey,
        index: u32,
        data: &[u8],
    ) -> TransactionResult {
        let ix = ix(
            soladb::instruction::WriteSegment {
                index,
                data: data.to_vec(),
            },
            soladb::accounts::WriteSegment {
                writer: writer.pubkey(),
                chunk: *chunk,
            },
        );
        self.send(&[ix], &[writer])
    }

    fn write_all(&mut self, writer: &Keypair, chunk: &Pubkey, data: &[u8], segment_size: u16) {
        for (i, part) in data.chunks(segment_size as usize).enumerate() {
            self.write_segment(writer, chunk, i as u32, part).unwrap();
        }
    }

    /// Open + write a full chunk owned by `owner`
    fn hot_chunk(&mut self, owner: &Keypair, data: &[u8], replicas: u8) -> Pubkey {
        let chunk = self.open_chunk(owner, data, 100, replicas);
        self.write_all(owner, &chunk, data, 100);
        chunk
    }

    fn confirm(&mut self, node: &Keypair, chunk: &Pubkey) -> TransactionResult {
        let ix = ix(
            soladb::instruction::ConfirmReplication {},
            soladb::accounts::ConfirmReplication {
                authority: node.pubkey(),
                replicator: replicator_pda(&node.pubkey()),
                chunk: *chunk,
                config: config_pda(),
            },
        );
        self.send(&[ix], &[node])
    }

    fn reclaim(&mut self, owner: &Keypair, chunk: &Pubkey) -> TransactionResult {
        let ix = ix(
            soladb::instruction::ReclaimUnreplicated {},
            soladb::accounts::OwnerChunk {
                owner: owner.pubkey(),
                chunk: *chunk,
            },
        );
        self.send(&[ix], &[owner])
    }

    fn close_chunk(&mut self, owner: &Keypair, chunk: &Pubkey) -> TransactionResult {
        let ix = ix(
            soladb::instruction::CloseChunk {},
            soladb::accounts::CloseChunk {
                owner: owner.pubkey(),
                chunk: *chunk,
            },
        );
        self.send(&[ix], &[owner])
    }

    fn create_record(&mut self, owner: &Keypair, content: &[u8]) -> (Pubkey, TransactionResult) {
        let nonce = self
            .fetch::<Identity>(&identity_pda(&owner.pubkey()))
            .record_nonce;
        let record = record_pda(&owner.pubkey(), nonce);
        let ix = ix(
            soladb::instruction::CreateRecord {
                schema: "soladb.file.v2".into(),
                content: content.to_vec(),
            },
            soladb::accounts::CreateRecord {
                owner: owner.pubkey(),
                identity: identity_pda(&owner.pubkey()),
                record,
                system_program: system_program::ID,
            },
        );
        (record, self.send(&[ix], &[owner]))
    }

    fn grant_ix(
        &self,
        owner: &Pubkey,
        record: &Pubkey,
        viewer: &Pubkey,
        content: &[u8],
    ) -> Instruction {
        ix(
            soladb::instruction::GrantAccess {
                content: content.to_vec(),
            },
            soladb::accounts::GrantAccess {
                owner: *owner,
                record: *record,
                viewer_identity: identity_pda(viewer),
                grant: grant_pda(record, viewer),
                system_program: system_program::ID,
            },
        )
    }

    fn revoke_ix(&self, owner: &Pubkey, record: &Pubkey, viewer: &Pubkey) -> Instruction {
        ix(
            soladb::instruction::RevokeAccess {},
            soladb::accounts::RevokeAccess {
                owner: *owner,
                record: *record,
                grant: grant_pda(record, viewer),
            },
        )
    }

    fn delete_ix(&self, owner: &Pubkey, record: &Pubkey) -> Instruction {
        ix(
            soladb::instruction::DeleteRecord {},
            soladb::accounts::DeleteRecord {
                owner: *owner,
                record: *record,
            },
        )
    }
}

/// Assert a transaction failed with a custom program error
fn assert_error(result: TransactionResult, expected: u32) {
    use solana_transaction::InstructionError;
    use solana_transaction::TransactionError;
    match result {
        Ok(_) => panic!("expected error {expected}, transaction succeeded"),
        Err(failed) => match failed.err {
            TransactionError::InstructionError(_, InstructionError::Custom(code)) => assert_eq!(
                code,
                expected,
                "wrong error code; logs:\n{}",
                failed.meta.logs.join("\n")
            ),
            other => panic!(
                "expected custom error {expected}, got {other:?}\n{}",
                failed.meta.logs.join("\n")
            ),
        },
    }
}

fn soladb_error(e: SolaDbError) -> u32 {
    e as u32 + anchor_lang::error::ERROR_CODE_OFFSET
}

const ACCOUNT_NOT_INITIALIZED: u32 = 3012;
const CONSTRAINT_HAS_ONE: u32 = 2001;

fn data(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i * 31 % 251) as u8).collect()
}

// ── admin ───────────────────────────────────────────────────────────────────

#[test]
fn initialize_stores_the_configuration() {
    let env = Env::new();
    let config: Config = env.fetch(&config_pda());
    assert_eq!(config.admin, env.admin.pubkey());
    assert_eq!(config.treasury, env.treasury);
    assert_eq!(config.base_fee_per_replica, BASE_FEE);
    assert_eq!(config.price_per_byte, PRICE_PER_BYTE);
    assert_eq!(config.protocol_fee_bps, 1_000);
    assert_eq!(config.replication_threshold_pct, 60);
    assert_eq!(config.replication_window, WINDOW);
}

#[test]
fn only_the_upgrade_authority_can_initialize() {
    let mut svm = LiteSVM::new();
    let bytes = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/soladb.so"));
    svm.add_program(soladb::id(), bytes).unwrap();
    let mut env = Env {
        svm,
        admin: Keypair::new(),
        treasury: Keypair::new().pubkey(),
    };
    let intruder = env.user();
    let params = env.params();
    assert_error(
        env.initialize(&intruder, params),
        soladb_error(SolaDbError::NotUpgradeAuthority),
    );
}

#[test]
fn config_updates_are_validated_and_admin_only() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let update = |params: ConfigParams, signer: &Keypair| {
        ix(
            soladb::instruction::UpdateConfig { params },
            soladb::accounts::AdminOnly {
                admin: signer.pubkey(),
                config: config_pda(),
            },
        )
    };

    let mut params = env.params();
    params.protocol_fee_bps = 3_001;
    assert_error(
        env.send(&[update(params, &admin)], &[&admin]),
        soladb_error(SolaDbError::InvalidParameter),
    );

    let mut params = env.params();
    params.replication_window = 60;
    assert_error(
        env.send(&[update(params, &admin)], &[&admin]),
        soladb_error(SolaDbError::InvalidParameter),
    );

    let stranger = env.user();
    assert_error(
        env.send(&[update(env.params(), &stranger)], &[&stranger]),
        CONSTRAINT_HAS_ONE,
    );

    let mut params = env.params();
    params.price_per_byte = 5;
    env.send(&[update(params, &admin)], &[&admin]).unwrap();
    assert_eq!(env.fetch::<Config>(&config_pda()).price_per_byte, 5);
}

#[test]
fn replicators_are_admin_approved_and_manage_their_endpoint() {
    let mut env = Env::new();
    let node = env.user();
    let stranger = env.user();

    // Only the admin registers replicators
    let ix_by_stranger = ix(
        soladb::instruction::RegisterReplicator {
            endpoint: "http://x".into(),
        },
        soladb::accounts::RegisterReplicator {
            admin: stranger.pubkey(),
            config: config_pda(),
            authority: node.pubkey(),
            replicator: replicator_pda(&node.pubkey()),
            system_program: system_program::ID,
        },
    );
    assert_error(
        env.send(&[ix_by_stranger], &[&stranger]),
        CONSTRAINT_HAS_ONE,
    );
    assert_error(
        env.register_replicator(&node.pubkey(), &"x".repeat(129)),
        soladb_error(SolaDbError::InvalidEndpoint),
    );

    env.register_replicator(&node.pubkey(), "http://node-1:3000")
        .unwrap();
    let replicator: Replicator = env.fetch(&replicator_pda(&node.pubkey()));
    assert!(replicator.active);
    assert_eq!(replicator.endpoint, "http://node-1:3000");

    let update = ix(
        soladb::instruction::UpdateReplicatorEndpoint {
            endpoint: "https://node-1.example".into(),
        },
        soladb::accounts::UpdateReplicatorEndpoint {
            authority: node.pubkey(),
            replicator: replicator_pda(&node.pubkey()),
        },
    );
    env.send(&[update], &[&node]).unwrap();

    let admin = env.admin.insecure_clone();
    let deactivate = ix(
        soladb::instruction::SetReplicatorActive { active: false },
        soladb::accounts::SetReplicatorActive {
            admin: admin.pubkey(),
            config: config_pda(),
            replicator: replicator_pda(&node.pubkey()),
        },
    );
    env.send(&[deactivate], &[&admin]).unwrap();
    let replicator: Replicator = env.fetch(&replicator_pda(&node.pubkey()));
    assert!(!replicator.active);
    assert_eq!(replicator.endpoint, "https://node-1.example");
}

// ── identity ────────────────────────────────────────────────────────────────

#[test]
fn identity_registration_and_rotation() {
    let mut env = Env::new();
    let user = env.registered_user();
    let identity: Identity = env.fetch(&identity_pda(&user.pubkey()));
    assert_eq!(identity.user, user.pubkey());
    assert_eq!(identity.encryption_key, [7; 32]);
    assert!(
        env.register_identity(&user).is_err(),
        "cannot register twice"
    );

    let rotate = ix(
        soladb::instruction::UpdateIdentity {
            encryption_key: [9; 32],
        },
        soladb::accounts::UpdateIdentity {
            user: user.pubkey(),
            identity: identity_pda(&user.pubkey()),
        },
    );
    env.send(&[rotate], &[&user]).unwrap();
    assert_eq!(
        env.fetch::<Identity>(&identity_pda(&user.pubkey()))
            .encryption_key,
        [9; 32]
    );
}

// ── storage: upload ─────────────────────────────────────────────────────────

#[test]
fn uploads_require_an_identity() {
    let mut env = Env::new();
    let user = env.user();
    let ix = env.open_chunk_ix(&user.pubkey(), &data(500), 100, 1, user.pubkey());
    assert_error(env.send(&[ix], &[&user]), ACCOUNT_NOT_INITIALIZED);
}

#[test]
fn open_chunk_splits_the_fee_between_treasury_and_escrow() {
    let mut env = Env::new();
    let owner = env.registered_user();
    let bytes = data(1_000);
    let treasury_before = env.balance(&env.treasury);
    let owner_before = env.balance(&owner.pubkey());

    let chunk = env.open_chunk(&owner, &bytes, 100, 3);

    // 3 × (20 000 + 1 000 × 2) = 66 000; 10 % protocol, 19 800 per replica
    let fee = 3 * (BASE_FEE + 1_000 * PRICE_PER_BYTE);
    assert_eq!(fee, 66_000);
    let state: Chunk = env.fetch(&chunk);
    assert_eq!(state.reward_per_replica, 19_800);
    assert_eq!(env.balance(&env.treasury) - treasury_before, 6_600);

    let account = env.svm.get_account(&chunk).unwrap();
    let rent = env
        .svm
        .minimum_balance_for_rent_exemption(account.data.len());
    assert_eq!(account.lamports, rent + 3 * 19_800);
    assert_eq!(account.data.len(), Chunk::space(10, 3));
    assert_eq!(
        owner_before - env.balance(&owner.pubkey()),
        fee + rent + 5_000
    );

    assert_eq!(state.owner, owner.pubkey());
    assert_eq!(state.content_hash, sha256(&bytes));
    assert_eq!(state.state, ChunkState::Pending);
    assert!(!state.needs_replicas);
    assert_eq!(state.segments_total, 10);
    assert_eq!(state.segments, vec![0, 0]);
    assert_eq!(state.size, 1_000);
    assert!(state.replicators.is_empty());
}

#[test]
fn open_chunk_validates_its_arguments() {
    let mut env = Env::new();
    let owner = env.registered_user();
    let me = owner.pubkey();
    let cases: Vec<(Vec<u8>, u16, u8, SolaDbError)> = vec![
        (data(100), 100, 0, SolaDbError::InvalidReplicas),
        (
            data(100),
            100,
            MAX_REPLICAS + 1,
            SolaDbError::InvalidReplicas,
        ),
        (data(100), 16, 1, SolaDbError::InvalidSegmentSize),
        (
            data(100),
            MAX_SEGMENT_SIZE + 1,
            1,
            SolaDbError::InvalidSegmentSize,
        ),
        (data(5_000 * 32 + 1), 32, 1, SolaDbError::TooManySegments),
    ];
    for (bytes, segment_size, replicas, error) in cases {
        let ix = env.open_chunk_ix(&me, &bytes, segment_size, replicas, me);
        assert_error(env.send(&[ix], &[&owner]), soladb_error(error));
    }

    // max_fee protects the uploader from a price change
    let bytes = data(1_000);
    let content_hash = sha256(&bytes);
    let ix = ix(
        soladb::instruction::OpenChunk {
            args: OpenChunkArgs {
                content_hash,
                size: 1_000,
                segment_size: 100,
                replicas: 1,
                writer: me,
                max_fee: 21_999,
            },
        },
        soladb::accounts::OpenChunk {
            owner: me,
            identity: identity_pda(&me),
            config: config_pda(),
            chunk: chunk_pda(&me, &content_hash),
            treasury: env.treasury,
            system_program: system_program::ID,
        },
    );
    assert_error(
        env.send(&[ix], &[&owner]),
        soladb_error(SolaDbError::FeeAboveMax),
    );

    // the treasury must be the configured one
    let mut ix = env.open_chunk_ix(&me, &bytes, 100, 1, me);
    ix.accounts[4].pubkey = Keypair::new().pubkey();
    assert_error(
        env.send(&[ix], &[&owner]),
        soladb_error(SolaDbError::InvalidTreasury),
    );
}

#[test]
fn owner_can_be_the_treasury() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    env.register_identity(&admin).unwrap();
    let mut params = env.params();
    params.treasury = admin.pubkey();
    let update = ix(
        soladb::instruction::UpdateConfig { params },
        soladb::accounts::AdminOnly {
            admin: admin.pubkey(),
            config: config_pda(),
        },
    );
    env.send(&[update], &[&admin]).unwrap();
    env.treasury = admin.pubkey();
    env.open_chunk(&admin, &data(300), 100, 1);
}

#[test]
fn segments_turn_the_chunk_hot_once_complete() {
    let mut env = Env::new();
    let owner = env.registered_user();
    let bytes = data(250);
    let chunk = env.open_chunk(&owner, &bytes, 100, 2);

    let stranger = env.user();
    assert_error(
        env.write_segment(&stranger, &chunk, 0, &bytes[..100]),
        soladb_error(SolaDbError::NotWriter),
    );
    assert_error(
        env.write_segment(&owner, &chunk, 3, &bytes[..50]),
        soladb_error(SolaDbError::InvalidSegmentIndex),
    );
    assert_error(
        env.write_segment(&owner, &chunk, 0, &bytes[..99]),
        soladb_error(SolaDbError::InvalidSegmentLength),
    );
    assert_error(
        env.write_segment(&owner, &chunk, 2, &bytes[200..249]),
        soladb_error(SolaDbError::InvalidSegmentLength),
    );

    // any order, each index once
    env.write_segment(&owner, &chunk, 2, &bytes[200..]).unwrap();
    assert_error(
        env.write_segment(&owner, &chunk, 2, &bytes[200..]),
        soladb_error(SolaDbError::SegmentAlreadyWritten),
    );
    env.write_segment(&owner, &chunk, 0, &bytes[..100]).unwrap();
    let state: Chunk = env.fetch(&chunk);
    assert_eq!(state.state, ChunkState::Pending);
    assert_eq!(state.segments_written, 2);
    assert_eq!(state.segments, vec![0b101]);

    env.write_segment(&owner, &chunk, 1, &bytes[100..200])
        .unwrap();
    let state: Chunk = env.fetch(&chunk);
    assert_eq!(state.state, ChunkState::Hot);
    assert!(state.needs_replicas);
    assert!(state.completed_at > 0);
    assert_error(
        env.write_segment(&owner, &chunk, 0, &bytes[..100]),
        soladb_error(SolaDbError::ChunkNotPending),
    );
}

#[test]
fn a_session_key_can_write_the_segments() {
    let mut env = Env::new();
    let owner = env.registered_user();
    let session = Keypair::new();
    let bytes = data(180);
    // open + fund the session key in one transaction
    let open = env.open_chunk_ix(&owner.pubkey(), &bytes, 100, 1, session.pubkey());
    let fund = transfer_ix(&owner.pubkey(), &session.pubkey(), SOL / 100);
    env.send(&[open, fund], &[&owner]).unwrap();
    let chunk = chunk_pda(&owner.pubkey(), &sha256(&bytes));

    assert_error(
        env.write_segment(&owner, &chunk, 0, &bytes[..100]),
        soladb_error(SolaDbError::NotWriter),
    );
    env.write_all(&session, &chunk, &bytes, 100);
    assert_eq!(env.fetch::<Chunk>(&chunk).state, ChunkState::Hot);
}

#[test]
fn chunk_sizes_that_divide_evenly_have_no_short_segment() {
    let mut env = Env::new();
    let owner = env.registered_user();
    let bytes = data(400);
    let chunk = env.open_chunk(&owner, &bytes, 100, 1);
    assert_eq!(env.fetch::<Chunk>(&chunk).segments_total, 4);
    env.write_all(&owner, &chunk, &bytes, 100);
    assert_eq!(env.fetch::<Chunk>(&chunk).state, ChunkState::Hot);
}

// ── storage: replication ────────────────────────────────────────────────────

#[test]
fn confirmations_pay_replicators_and_cool_the_chunk() {
    let mut env = Env::new();
    let owner = env.registered_user();
    let (a, b, c, d) = (
        env.replicator(),
        env.replicator(),
        env.replicator(),
        env.replicator(),
    );
    let bytes = data(1_000);

    let pending = env.open_chunk(&owner, &bytes, 100, 3);
    assert_error(
        env.confirm(&a, &pending),
        soladb_error(SolaDbError::ChunkIncomplete),
    );
    env.write_all(&owner, &pending, &bytes, 100);
    let chunk = pending;

    let reward = env.fetch::<Chunk>(&chunk).reward_per_replica;
    let before = env.balance(&a.pubkey());
    env.confirm(&a, &chunk).unwrap();
    assert_eq!(env.balance(&a.pubkey()), before + reward - 5_000);

    // 60 % of 3 rounds down to 1 confirmation
    let state: Chunk = env.fetch(&chunk);
    assert_eq!(state.state, ChunkState::Cool);
    assert_eq!(state.confirmed_replicas, 1);
    assert!(
        state.needs_replicas,
        "still short of the requested replicas"
    );
    assert_eq!(state.replicators, vec![a.pubkey()]);

    assert_error(
        env.confirm(&a, &chunk),
        soladb_error(SolaDbError::AlreadyReplicated),
    );
    env.confirm(&b, &chunk).unwrap();
    env.confirm(&c, &chunk).unwrap();
    assert_error(
        env.confirm(&d, &chunk),
        soladb_error(SolaDbError::FullyReplicated),
    );

    let state: Chunk = env.fetch(&chunk);
    assert_eq!(state.confirmed_replicas, 3);
    assert!(!state.needs_replicas);
    let account = env.svm.get_account(&chunk).unwrap();
    assert_eq!(
        account.lamports,
        env.svm
            .minimum_balance_for_rent_exemption(account.data.len())
    );

    let replicator: Replicator = env.fetch(&replicator_pda(&a.pubkey()));
    assert_eq!(replicator.confirmations, 1);
    assert_eq!(replicator.lamports_earned, reward);
}

#[test]
fn only_active_registered_replicators_confirm() {
    let mut env = Env::new();
    let owner = env.registered_user();
    let chunk = env.hot_chunk(&owner, &data(300), 2);
    let stranger = env.user();
    assert_error(env.confirm(&stranger, &chunk), ACCOUNT_NOT_INITIALIZED);

    let node = env.replicator();
    let admin = env.admin.insecure_clone();
    let deactivate = ix(
        soladb::instruction::SetReplicatorActive { active: false },
        soladb::accounts::SetReplicatorActive {
            admin: admin.pubkey(),
            config: config_pda(),
            replicator: replicator_pda(&node.pubkey()),
        },
    );
    env.send(&[deactivate], &[&admin]).unwrap();
    assert_error(
        env.confirm(&node, &chunk),
        soladb_error(SolaDbError::ReplicatorInactive),
    );
}

#[test]
fn threshold_needs_a_majority_for_larger_replica_counts() {
    let mut env = Env::new();
    let owner = env.registered_user();
    let nodes: Vec<Keypair> = (0..3).map(|_| env.replicator()).collect();
    let chunk = env.hot_chunk(&owner, &data(300), 5); // 60 % of 5 = 3
    for (i, node) in nodes.iter().enumerate() {
        assert_eq!(
            env.fetch::<Chunk>(&chunk).state,
            ChunkState::Hot,
            "before confirmation {i}"
        );
        env.confirm(node, &chunk).unwrap();
    }
    assert_eq!(env.fetch::<Chunk>(&chunk).state, ChunkState::Cool);
}

#[test]
fn uploader_reclaims_unfilled_slots_after_the_window() {
    let mut env = Env::new();
    let owner = env.registered_user();
    let node = env.replicator();
    let late = env.replicator();
    let chunk = env.hot_chunk(&owner, &data(1_000), 3);
    env.confirm(&node, &chunk).unwrap();

    assert_error(
        env.reclaim(&owner, &chunk),
        soladb_error(SolaDbError::ReplicationWindowOpen),
    );
    env.warp(WINDOW);

    let stranger = env.registered_user();
    assert_error(
        env.reclaim(&stranger, &chunk),
        soladb_error(SolaDbError::NotOwner),
    );

    let reward = env.fetch::<Chunk>(&chunk).reward_per_replica;
    let before = env.balance(&owner.pubkey());
    env.reclaim(&owner, &chunk).unwrap();
    assert_eq!(env.balance(&owner.pubkey()), before + 2 * reward - 5_000);

    let state: Chunk = env.fetch(&chunk);
    assert!(state.reclaimed);
    assert!(!state.needs_replicas);
    assert_error(
        env.reclaim(&owner, &chunk),
        soladb_error(SolaDbError::ReplicationClosed),
    );
    assert_error(
        env.confirm(&late, &chunk),
        soladb_error(SolaDbError::ReplicationClosed),
    );
}

#[test]
fn nothing_to_reclaim_when_fully_replicated() {
    let mut env = Env::new();
    let owner = env.registered_user();
    let node = env.replicator();
    let chunk = env.hot_chunk(&owner, &data(100), 1);
    env.confirm(&node, &chunk).unwrap();
    env.warp(WINDOW);
    assert_error(
        env.reclaim(&owner, &chunk),
        soladb_error(SolaDbError::NothingToClaim),
    );
}

#[test]
fn closing_a_chunk_refunds_rent_and_escrow() {
    let mut env = Env::new();
    let owner = env.registered_user();
    let node = env.replicator();

    // Pending: abort the upload, everything comes back except the fees paid
    let bytes = data(500);
    let pending = env.open_chunk(&owner, &bytes, 100, 2);
    let locked = env.balance(&pending);
    let before = env.balance(&owner.pubkey());
    env.close_chunk(&owner, &pending).unwrap();
    assert!(!env.exists(&pending));
    assert_eq!(env.balance(&owner.pubkey()), before + locked - 5_000);

    // Hot inside the window: replicators may be working on it
    let chunk = env.hot_chunk(&owner, &data(600), 2);
    env.confirm(&node, &chunk).unwrap();
    assert_error(
        env.close_chunk(&owner, &chunk),
        soladb_error(SolaDbError::ChunkNotSettled),
    );

    // after the window the unfilled escrow comes back with the rent
    env.warp(WINDOW);
    let locked = env.balance(&chunk);
    let before = env.balance(&owner.pubkey());
    env.close_chunk(&owner, &chunk).unwrap();
    assert_eq!(env.balance(&owner.pubkey()), before + locked - 5_000);

    // fully replicated chunks close right away
    let chunk = env.hot_chunk(&owner, &data(700), 1);
    env.confirm(&node, &chunk).unwrap();
    env.close_chunk(&owner, &chunk).unwrap();
    assert!(!env.exists(&chunk));
}

// ── records ─────────────────────────────────────────────────────────────────

#[test]
fn records_are_addressed_by_owner_nonce() {
    let mut env = Env::new();
    let owner = env.registered_user();
    let (first, result) = env.create_record(&owner, b"sealed manifest one");
    result.unwrap();
    let (second, result) = env.create_record(&owner, b"sealed manifest two");
    result.unwrap();
    assert_eq!(first, record_pda(&owner.pubkey(), 0));
    assert_eq!(second, record_pda(&owner.pubkey(), 1));

    let record: Record = env.fetch(&second);
    assert_eq!(record.owner, owner.pubkey());
    assert_eq!(record.nonce, 1);
    assert_eq!(record.schema, "soladb.file.v2");
    assert_eq!(record.content, b"sealed manifest two");
    assert_eq!(
        env.fetch::<Identity>(&identity_pda(&owner.pubkey()))
            .record_nonce,
        2
    );
}

#[test]
fn record_content_is_bounded_and_identity_gated() {
    let mut env = Env::new();
    let owner = env.registered_user();
    let (_, result) = env.create_record(&owner, &[]);
    assert_error(result, soladb_error(SolaDbError::InvalidContent));
    let (_, result) = env.create_record(&owner, &vec![1; MAX_RECORD_CONTENT + 1]);
    assert!(result.is_err(), "oversized content does not fit");

    let anonymous = env.user();
    let ix = ix(
        soladb::instruction::CreateRecord {
            schema: "x".into(),
            content: vec![1],
        },
        soladb::accounts::CreateRecord {
            owner: anonymous.pubkey(),
            identity: identity_pda(&anonymous.pubkey()),
            record: record_pda(&anonymous.pubkey(), 0),
            system_program: system_program::ID,
        },
    );
    assert_error(env.send(&[ix], &[&anonymous]), ACCOUNT_NOT_INITIALIZED);
}

#[test]
fn update_record_reallocates() {
    let mut env = Env::new();
    let owner = env.registered_user();
    let (record, result) = env.create_record(&owner, b"short");
    result.unwrap();

    let update = |owner: &Keypair, content: &[u8]| {
        ix(
            soladb::instruction::UpdateRecord {
                content: content.to_vec(),
            },
            soladb::accounts::UpdateRecord {
                owner: owner.pubkey(),
                record,
                system_program: system_program::ID,
            },
        )
    };
    let long = vec![42u8; 900];
    env.send(&[update(&owner, &long)], &[&owner]).unwrap();
    assert_eq!(env.fetch::<Record>(&record).content, long);
    env.send(&[update(&owner, b"tiny")], &[&owner]).unwrap();
    assert_eq!(env.fetch::<Record>(&record).content, b"tiny");
    let account = env.svm.get_account(&record).unwrap();
    assert_eq!(account.data.len(), Record::space("soladb.file.v2".len(), 4));

    let stranger = env.registered_user();
    assert_error(
        env.send(&[update(&stranger, b"mine")], &[&stranger]),
        soladb_error(SolaDbError::NotOwner),
    );
}

#[test]
fn grants_give_viewers_their_own_sealed_copy() {
    let mut env = Env::new();
    let owner = env.registered_user();
    let viewer = env.registered_user();
    let unregistered = env.user();
    let (record, result) = env.create_record(&owner, b"for the owner");
    result.unwrap();
    let me = owner.pubkey();

    let self_grant = env.grant_ix(&me, &record, &me, b"x");
    assert_error(
        env.send(&[self_grant], &[&owner]),
        soladb_error(SolaDbError::CannotGrantSelf),
    );
    let to_unregistered = env.grant_ix(&me, &record, &unregistered.pubkey(), b"x");
    assert_error(
        env.send(&[to_unregistered], &[&owner]),
        ACCOUNT_NOT_INITIALIZED,
    );
    let by_stranger = env.grant_ix(&viewer.pubkey(), &record, &me, b"x");
    assert_error(
        env.send(&[by_stranger], &[&viewer]),
        soladb_error(SolaDbError::NotOwner),
    );

    let grant = env.grant_ix(&me, &record, &viewer.pubkey(), b"for the viewer");
    env.send(&[grant], &[&owner]).unwrap();
    let grant_address = grant_pda(&record, &viewer.pubkey());
    let grant: Grant = env.fetch(&grant_address);
    assert_eq!(grant.viewer, viewer.pubkey());
    assert_eq!(grant.owner, me);
    assert_eq!(grant.record, record);
    assert_eq!(grant.content, b"for the viewer");
    assert_eq!(env.fetch::<Record>(&record).viewer_count, 1);

    let update = ix(
        soladb::instruction::UpdateGrant {
            content: b"re-sealed copy for the viewer".to_vec(),
        },
        soladb::accounts::UpdateGrant {
            owner: me,
            grant: grant_address,
            system_program: system_program::ID,
        },
    );
    env.send(&[update], &[&owner]).unwrap();
    assert_eq!(
        env.fetch::<Grant>(&grant_address).content,
        b"re-sealed copy for the viewer"
    );
}

#[test]
fn delete_needs_every_viewer_revoked_first() {
    let mut env = Env::new();
    let owner = env.registered_user();
    let (v1, v2) = (env.registered_user(), env.registered_user());
    let (record, result) = env.create_record(&owner, b"manifest");
    result.unwrap();
    let me = owner.pubkey();
    let grants = [
        env.grant_ix(&me, &record, &v1.pubkey(), b"a"),
        env.grant_ix(&me, &record, &v2.pubkey(), b"b"),
    ];
    env.send(&grants, &[&owner]).unwrap();

    let delete = env.delete_ix(&me, &record);
    assert_error(
        env.send(std::slice::from_ref(&delete), &[&owner]),
        soladb_error(SolaDbError::RecordHasViewers),
    );

    let before = env.balance(&me);
    let locked = env.balance(&record)
        + env.balance(&grant_pda(&record, &v1.pubkey()))
        + env.balance(&grant_pda(&record, &v2.pubkey()));
    let batch = [
        env.revoke_ix(&me, &record, &v1.pubkey()),
        env.revoke_ix(&me, &record, &v2.pubkey()),
        delete,
    ];
    env.send(&batch, &[&owner]).unwrap();

    assert!(!env.exists(&record));
    assert!(!env.exists(&grant_pda(&record, &v1.pubkey())));
    assert_eq!(env.balance(&me), before + locked - 5_000);
}

#[test]
fn revoke_checks_the_grant_belongs_to_the_record() {
    let mut env = Env::new();
    let owner = env.registered_user();
    let viewer = env.registered_user();
    let (first, r1) = env.create_record(&owner, b"one");
    r1.unwrap();
    let (second, r2) = env.create_record(&owner, b"two");
    r2.unwrap();
    let me = owner.pubkey();
    let grant = env.grant_ix(&me, &first, &viewer.pubkey(), b"x");
    env.send(&[grant], &[&owner]).unwrap();

    let mismatched = ix(
        soladb::instruction::RevokeAccess {},
        soladb::accounts::RevokeAccess {
            owner: me,
            record: second,
            grant: grant_pda(&first, &viewer.pubkey()),
        },
    );
    assert_error(
        env.send(&[mismatched], &[&owner]),
        soladb_error(SolaDbError::GrantMismatch),
    );
    let revoke = env.revoke_ix(&me, &first, &viewer.pubkey());
    env.send(&[revoke], &[&owner]).unwrap();
    assert_eq!(env.fetch::<Record>(&first).viewer_count, 0);
}
