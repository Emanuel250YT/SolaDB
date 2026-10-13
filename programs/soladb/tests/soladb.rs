//! Program tests on LiteSVM: admin, identity, chunk economics, records and blobs.
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
        instructions::{OpenBlobArgs, OpenChunkArgs},
        state::{
            Blob, BlobState, Chunk, ChunkState, Config, ConfigParams, Grant, Identity, Record,
            Replicator,
        },
    },
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

const SOL: u64 = 1_000_000_000;
const BASE_FEE: u64 = 20_000;
/// 2 lamports per byte, so the fee arithmetic below stays readable
const PRICE_PER_MIB: u64 = 2 * 1024 * 1024;
const WINDOW: i64 = 7 * 86_400;
const EPOCH: i64 = 86_400;
const PRICE_PER_MIB_EPOCH: u64 = 1_000;
const CHALLENGE_WINDOW: u64 = 100;
const BOUNTY_BPS: u16 = 1_000;

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
fn blob_pda(owner: &Pubkey, root: &[u8; 32]) -> Pubkey {
    pda(&[BLOB_SEED, owner.as_ref(), root])
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
            price_per_mib: PRICE_PER_MIB,
            protocol_fee_bps: 1_000,
            replication_threshold_pct: 60,
            replication_window: WINDOW,
            epoch_seconds: EPOCH,
            price_per_mib_epoch: PRICE_PER_MIB_EPOCH,
            challenge_window_slots: CHALLENGE_WINDOW,
            challenge_cooldown: 0,
            challenger_bounty_bps: BOUNTY_BPS,
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
        let owner = match self.svm.get_account(chunk) {
            Some(account) if !account.data.is_empty() => {
                Chunk::try_deserialize(&mut account.data.as_slice())
                    .unwrap()
                    .owner
            }
            _ => Pubkey::new_unique(),
        };
        self.confirm_as(node, chunk, &owner)
    }

    fn confirm_as(&mut self, node: &Keypair, chunk: &Pubkey, owner: &Pubkey) -> TransactionResult {
        let ix = ix(
            soladb::instruction::ConfirmReplication {},
            soladb::accounts::ConfirmReplication {
                authority: node.pubkey(),
                replicator: replicator_pda(&node.pubkey()),
                chunk: *chunk,
                config: config_pda(),
                owner: *owner,
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
    assert_eq!(config.price_per_mib, PRICE_PER_MIB);
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
    params.price_per_mib = 5;
    env.send(&[update(params, &admin)], &[&admin]).unwrap();
    assert_eq!(env.fetch::<Config>(&config_pda()).price_per_mib, 5);
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
    let fee = 3 * (BASE_FEE + 1_000 * PRICE_PER_MIB / (1024 * 1024));
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

    // the last confirmation closes the chunk: only its rent was left, and it
    // goes back to the owner
    let account = env.svm.get_account(&chunk).unwrap();
    let rent = env
        .svm
        .minimum_balance_for_rent_exemption(account.data.len());
    assert_eq!(account.lamports, rent + reward);
    let owner_before = env.balance(&owner.pubkey());
    env.confirm(&c, &chunk).unwrap();
    assert!(!env.exists(&chunk));
    assert_eq!(env.balance(&owner.pubkey()), owner_before + rent);
    assert_error(
        env.confirm_as(&d, &chunk, &owner.pubkey()),
        ACCOUNT_NOT_INITIALIZED,
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
fn nothing_to_reclaim_once_fully_replicated() {
    let mut env = Env::new();
    let owner = env.registered_user();
    let node = env.replicator();
    let chunk = env.hot_chunk(&owner, &data(100), 1);
    env.confirm(&node, &chunk).unwrap();
    assert!(!env.exists(&chunk), "closed by its last confirmation");
    env.warp(WINDOW);
    assert_error(env.reclaim(&owner, &chunk), ACCOUNT_NOT_INITIALIZED);
}

#[test]
fn confirmation_needs_the_chunk_owner_account() {
    let mut env = Env::new();
    let owner = env.registered_user();
    let node = env.replicator();
    let chunk = env.hot_chunk(&owner, &data(100), 1);
    let stranger = Keypair::new().pubkey();
    assert_error(
        env.confirm_as(&node, &chunk, &stranger),
        soladb_error(SolaDbError::InvalidChunkOwner),
    );
    env.confirm(&node, &chunk).unwrap();
}

#[test]
fn a_replicator_can_confirm_its_own_upload() {
    let mut env = Env::new();
    let node = env.replicator();
    env.register_identity(&node).unwrap();
    let chunk = env.open_chunk(&node, &data(300), 0, 1);
    let before = env.balance(&node.pubkey());
    let locked = env.balance(&chunk);
    env.confirm(&node, &chunk).unwrap();
    assert!(!env.exists(&chunk));
    // reward + rent come back to the same wallet, minus the transaction fee
    assert_eq!(env.balance(&node.pubkey()), before + locked - 5_000);
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

    // fully replicated chunks are already closed
    let chunk = env.hot_chunk(&owner, &data(700), 1);
    env.confirm(&node, &chunk).unwrap();
    assert!(!env.exists(&chunk));
    assert_error(env.close_chunk(&owner, &chunk), ACCOUNT_NOT_INITIALIZED);
}

// ── storage: direct chunks and pricing ──────────────────────────────────────

#[test]
fn direct_chunks_wait_for_replicas_right_away() {
    let mut env = Env::new();
    let owner = env.registered_user();
    let bytes = data(5_000);
    let chunk = env.open_chunk(&owner, &bytes, 0, 2);

    let state: Chunk = env.fetch(&chunk);
    assert!(state.is_direct());
    assert_eq!(state.state, ChunkState::Hot);
    assert!(state.needs_replicas);
    assert_eq!(state.segments_total, 0);
    assert!(state.segments.is_empty());
    assert!(state.completed_at > 0);
    assert_eq!(
        env.svm.get_account(&chunk).unwrap().data.len(),
        Chunk::space(0, 2)
    );

    // nothing goes to the ledger
    assert_error(
        env.write_segment(&owner, &chunk, 0, &bytes[..100]),
        soladb_error(SolaDbError::ChunkNotPending),
    );

    let (a, b) = (env.replicator(), env.replicator());
    env.confirm(&a, &chunk).unwrap();
    assert_eq!(env.fetch::<Chunk>(&chunk).state, ChunkState::Cool);
    let owner_before = env.balance(&owner.pubkey());
    let rent = env.balance(&chunk) - env.fetch::<Chunk>(&chunk).reward_per_replica;
    env.confirm(&b, &chunk).unwrap();
    assert!(!env.exists(&chunk));
    assert_eq!(env.balance(&owner.pubkey()), owner_before + rent);
}

#[test]
fn direct_chunks_can_be_up_to_16_mib() {
    let mut env = Env::new();
    let owner = env.registered_user();
    let me = owner.pubkey();
    let big = data(MAX_DIRECT_CHUNK_SIZE as usize);
    let ix = env.open_chunk_ix(&me, &big, 0, 1, me);
    env.send(&[ix], &[&owner]).unwrap();

    let too_big = data(MAX_DIRECT_CHUNK_SIZE as usize + 1);
    let ix = env.open_chunk_ix(&me, &too_big, 0, 1, me);
    assert_error(
        env.send(&[ix], &[&owner]),
        soladb_error(SolaDbError::InvalidSize),
    );

    // ledger chunks stay capped at 1 MiB
    let ledger = data(MAX_CHUNK_SIZE as usize + 1);
    let ix = env.open_chunk_ix(&me, &ledger, 4_000, 1, me);
    assert_error(
        env.send(&[ix], &[&owner]),
        soladb_error(SolaDbError::InvalidSize),
    );
}

#[test]
fn unconfirmed_direct_chunks_can_be_aborted_after_a_delay() {
    let mut env = Env::new();
    let owner = env.registered_user();
    let chunk = env.open_chunk(&owner, &data(800), 0, 2);
    assert_error(
        env.close_chunk(&owner, &chunk),
        soladb_error(SolaDbError::ChunkNotSettled),
    );
    env.warp(DIRECT_ABORT_DELAY);
    let locked = env.balance(&chunk);
    let before = env.balance(&owner.pubkey());
    env.close_chunk(&owner, &chunk).unwrap();
    assert_eq!(env.balance(&owner.pubkey()), before + locked - 5_000);

    // once a replica confirmed, the other slots wait for the window
    let chunk = env.open_chunk(&owner, &data(900), 0, 2);
    let node = env.replicator();
    env.confirm(&node, &chunk).unwrap();
    env.warp(DIRECT_ABORT_DELAY);
    assert_error(
        env.close_chunk(&owner, &chunk),
        soladb_error(SolaDbError::ChunkNotSettled),
    );
}

#[test]
fn storage_is_priced_per_mib_pro_rata() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let mut params = env.params();
    params.base_fee_per_replica = 7_000;
    params.price_per_mib = 20_000;
    let update = ix(
        soladb::instruction::UpdateConfig { params },
        soladb::accounts::AdminOnly {
            admin: admin.pubkey(),
            config: config_pda(),
        },
    );
    env.send(&[update], &[&admin]).unwrap();
    let config: Config = env.fetch(&config_pda());

    // a byte still costs one lamport of storage (rounded up), a MiB 20 000
    assert_eq!(config.quote(1, 1).unwrap(), 7_001);
    assert_eq!(config.quote(1024 * 1024, 2).unwrap(), 2 * 27_000);
    assert_eq!(config.quote(512 * 1024, 1).unwrap(), 17_000);

    let owner = env.registered_user();
    let bytes = data(3 * 1024 * 1024);
    let treasury_before = env.balance(&env.treasury);
    let chunk = env.open_chunk(&owner, &bytes, 0, 2);
    let fee = 2 * (7_000 + 3 * 20_000);
    assert_eq!(env.balance(&env.treasury) - treasury_before, fee / 10);
    assert_eq!(env.fetch::<Chunk>(&chunk).reward_per_replica, fee * 9 / 20);
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

// ── blobs ───────────────────────────────────────────────────────────────────
//
// The Merkle math below is written from docs/blob-protocol.md independently
// of the program's, so the two check each other.

const LEAF: u8 = 0;
const NODE: u8 = 1;

fn leaf(segment: &[u8]) -> [u8; 32] {
    Sha256::new()
        .chain_update([LEAF])
        .chain_update(segment)
        .finalize()
        .into()
}

fn node(l: &[u8; 32], r: &[u8; 32]) -> [u8; 32] {
    Sha256::new()
        .chain_update([NODE])
        .chain_update(l)
        .chain_update(r)
        .finalize()
        .into()
}

/// Every level of the padded tree, leaves first
fn levels(nodes: &[[u8; 32]]) -> Vec<Vec<[u8; 32]>> {
    let mut level = nodes.to_vec();
    level.resize(nodes.len().next_power_of_two(), [0; 32]);
    let mut out = vec![level.clone()];
    while level.len() > 1 {
        level = level.chunks(2).map(|p| node(&p[0], &p[1])).collect();
        out.push(level.clone());
    }
    out
}

fn root_of(nodes: &[[u8; 32]]) -> [u8; 32] {
    levels(nodes).last().unwrap()[0]
}

fn proof_of(nodes: &[[u8; 32]], index: usize) -> Vec<[u8; 32]> {
    let all = levels(nodes);
    (0..all.len() - 1)
        .map(|l| all[l][(index >> l) ^ 1])
        .collect()
}

/// Test shards: `n` shards of `segments` KiB each, plus their Merkle data
struct TestBlob {
    shards: Vec<Vec<u8>>,
    shard_roots: Vec<[u8; 32]>,
    root: [u8; 32],
}

impl TestBlob {
    fn new(n: usize, segments: usize, seed: u8) -> Self {
        let shards: Vec<Vec<u8>> = (0..n)
            .map(|j| {
                (0..segments * 1024)
                    // every 1 KiB segment differs, so a proof only fits its own segment
                    .map(|i| ((i * 7 + (i / 1024) * 29 + j * 131) as u8) ^ seed)
                    .collect()
            })
            .collect();
        let shard_roots: Vec<[u8; 32]> = shards
            .iter()
            .map(|s| root_of(&s.chunks(1024).map(leaf).collect::<Vec<_>>()))
            .collect();
        let root = root_of(&shard_roots);
        TestBlob {
            shards,
            shard_roots,
            root,
        }
    }

    fn shard_size(&self) -> u64 {
        self.shards[0].len() as u64
    }

    /// Segment, shard proof and top proof answering a challenge
    fn answer(&self, index: usize, segment: usize) -> (Vec<u8>, Vec<[u8; 32]>, Vec<[u8; 32]>) {
        let leaves: Vec<[u8; 32]> = self.shards[index].chunks(1024).map(leaf).collect();
        (
            self.shards[index][segment * 1024..(segment + 1) * 1024].to_vec(),
            proof_of(&leaves, segment),
            proof_of(&self.shard_roots, index),
        )
    }
}

fn challenged_segment(slot_hash: &[u8; 32], blob: &Pubkey, index: u8, segments: u64) -> usize {
    let seed: [u8; 32] = Sha256::new()
        .chain_update(slot_hash)
        .chain_update(blob.as_ref())
        .chain_update([index])
        .finalize()
        .into();
    (u64::from_le_bytes(seed[..8].try_into().unwrap()) % segments) as usize
}

impl Env {
    fn open_blob_ix(&self, owner: &Pubkey, blob: &TestBlob, k: u8, epochs: u32) -> Instruction {
        ix(
            soladb::instruction::OpenBlob {
                args: OpenBlobArgs {
                    root: blob.root,
                    data_shards: k,
                    total_shards: blob.shards.len() as u8,
                    shard_size: blob.shard_size(),
                    payload_size: blob.shard_size() * k as u64,
                    epochs,
                    max_fee: u64::MAX,
                },
            },
            soladb::accounts::OpenBlob {
                owner: *owner,
                identity: identity_pda(owner),
                config: config_pda(),
                blob: blob_pda(owner, &blob.root),
                treasury: self.treasury,
                system_program: system_program::ID,
            },
        )
    }

    fn open_blob(&mut self, owner: &Keypair, blob: &TestBlob, k: u8, epochs: u32) -> Pubkey {
        let ix = self.open_blob_ix(&owner.pubkey(), blob, k, epochs);
        self.send(&[ix], &[owner]).unwrap();
        blob_pda(&owner.pubkey(), &blob.root)
    }

    fn confirm_shard(&mut self, node: &Keypair, blob: &Pubkey, index: u8) -> TransactionResult {
        let ix = ix(
            soladb::instruction::ConfirmShard { index },
            soladb::accounts::ConfirmShard {
                authority: node.pubkey(),
                replicator: replicator_pda(&node.pubkey()),
                blob: *blob,
                config: config_pda(),
            },
        );
        self.send(&[ix], &[node])
    }

    fn challenge(&mut self, who: &Keypair, blob: &Pubkey, index: u8) -> TransactionResult {
        let ix = ix(
            soladb::instruction::CreateChallenge { index },
            soladb::accounts::CreateChallenge {
                challenger: who.pubkey(),
                blob: *blob,
                config: config_pda(),
            },
        );
        self.send(&[ix], &[who])
    }

    fn prove(
        &mut self,
        who: &Keypair,
        blob: &Pubkey,
        index: u8,
        answer: (Vec<u8>, Vec<[u8; 32]>, Vec<[u8; 32]>),
    ) -> TransactionResult {
        let ix = ix(
            soladb::instruction::ProveShard {
                index,
                segment: answer.0,
                shard_proof: answer.1,
                top_proof: answer.2,
            },
            soladb::accounts::ProveShard {
                prover: who.pubkey(),
                blob: *blob,
                slot_hashes: SLOT_HASHES_ID,
            },
        );
        self.send(&[ix], &[who])
    }

    fn fail(&mut self, who: &Keypair, blob: &Pubkey, index: u8) -> TransactionResult {
        let ix = ix(
            soladb::instruction::FailChallenge { index },
            soladb::accounts::FailChallenge {
                reporter: who.pubkey(),
                blob: *blob,
                config: config_pda(),
                slot_hashes: SLOT_HASHES_ID,
            },
        );
        self.send(&[ix], &[who])
    }

    fn claim(&mut self, node: &Keypair, blob: &Pubkey, index: u8) -> TransactionResult {
        let ix = ix(
            soladb::instruction::ClaimShardRewards { index },
            soladb::accounts::ClaimShardRewards {
                holder: node.pubkey(),
                replicator: replicator_pda(&node.pubkey()),
                blob: *blob,
                config: config_pda(),
            },
        );
        self.send(&[ix], &[node])
    }

    fn close_blob(&mut self, owner: &Keypair, blob: &Pubkey) -> TransactionResult {
        let ix = ix(
            soladb::instruction::CloseBlob {},
            soladb::accounts::CloseBlob {
                owner: owner.pubkey(),
                blob: *blob,
                config: config_pda(),
            },
        );
        self.send(&[ix], &[owner])
    }

    fn slot(&self) -> u64 {
        self.svm.get_sysvar::<Clock>().slot
    }

    /// Move the clock forward `slots` slots (and as many half seconds)
    fn warp_slots(&mut self, slots: u64) {
        let mut clock: Clock = self.svm.get_sysvar();
        clock.slot += slots;
        clock.unix_timestamp += slots as i64 / 2;
        self.svm.set_sysvar(&clock);
    }

    /// SlotHashes sysvar with one known hash per slot in `slots` (others = skipped)
    fn set_slot_hashes(&mut self, slots: &[u64]) -> Vec<[u8; 32]> {
        let mut sorted = slots.to_vec();
        sorted.sort_unstable_by(|a, b| b.cmp(a));
        let hashes: Vec<[u8; 32]> = sorted.iter().map(|s| sha256(&s.to_le_bytes())).collect();
        let mut data = (sorted.len() as u64).to_le_bytes().to_vec();
        for (slot, hash) in sorted.iter().zip(&hashes) {
            data.extend_from_slice(&slot.to_le_bytes());
            data.extend_from_slice(hash);
        }
        let clock_id: Pubkey = "SysvarC1ock11111111111111111111111111111111"
            .parse()
            .unwrap();
        let mut account = self.svm.get_account(&clock_id).unwrap();
        account.lamports = SOL;
        account.data = data;
        self.svm.set_account(SLOT_HASHES_ID, account).unwrap();
        slots.iter().map(|s| sha256(&s.to_le_bytes())).collect()
    }

    /// Answer the challenge open on `index` (e.g. the one confirm_shard opens)
    fn answer_open(&mut self, who: &Keypair, blob: &Pubkey, index: u8, data: &TestBlob) {
        let state: Blob = self.fetch(blob);
        let target = state.slots[index as usize].challenge_slot;
        assert_ne!(target, 0, "a challenge is open");
        let now = self.slot();
        if now <= target {
            self.warp_slots(target + 1 - now);
        }
        let hash = self.set_slot_hashes(&[target - 1, target, target + 1])[1];
        let segment = challenged_segment(&hash, blob, index, state.shard_segments());
        self.prove(who, blob, index, data.answer(index as usize, segment))
            .unwrap();
    }

    /// Open a challenge on `index`, let its slot pass, return the challenged segment
    fn challenge_ready(&mut self, who: &Keypair, blob: &Pubkey, index: u8) -> usize {
        self.challenge(who, blob, index).unwrap();
        let state: Blob = self.fetch(blob);
        let target = state.slots[index as usize].challenge_slot;
        assert_eq!(target, self.slot() + CHALLENGE_DELAY_SLOTS);
        self.warp_slots(CHALLENGE_DELAY_SLOTS + 1);
        let hash = self.set_slot_hashes(&[target - 1, target, target + 1])[1];
        challenged_segment(&hash, blob, index, state.shard_segments())
    }
}

#[test]
fn open_blob_prepays_storage_and_escrows_it_per_shard_epoch() {
    let mut env = Env::new();
    let owner = env.registered_user();
    let blob = TestBlob::new(3, 4, 1); // 3 shards of 4 KiB
    let treasury_before = env.balance(&env.treasury);
    let address = env.open_blob(&owner, &blob, 2, 10);

    // 3 × (20 000 + ⌈4096 × 1000 × 10 / MiB⌉) = 3 × (20 000 + 40) = 60 120
    let fee = 3 * (BASE_FEE + 40);
    let protocol = fee / 10;
    let reward = (fee - protocol) / 30;
    let state: Blob = env.fetch(&address);
    assert_eq!(state.reward_per_shard_epoch, reward);
    assert_eq!(
        env.balance(&env.treasury) - treasury_before,
        fee - reward * 30
    );
    let account = env.svm.get_account(&address).unwrap();
    assert_eq!(account.data.len(), Blob::space(3));
    assert_eq!(
        account.lamports,
        env.svm
            .minimum_balance_for_rent_exemption(account.data.len())
            + reward * 30
    );
    assert_eq!(state.owner, owner.pubkey());
    assert_eq!(state.root, blob.root);
    assert_eq!(state.state, BlobState::Hot);
    assert!(state.needs_holders);
    assert_eq!(
        (state.data_shards, state.total_shards, state.held),
        (2, 3, 0)
    );
    assert_eq!(state.expires_at, state.opened_at + 10 * EPOCH);
    assert!(state.slots.iter().all(|s| s.is_vacant()));
    // nodes find work with one memcmp
    assert_eq!(account.data[soladb::state::blob_offsets::NEEDS_HOLDERS], 1);
}

#[test]
fn open_blob_validates_its_layout() {
    let mut env = Env::new();
    let owner = env.registered_user();
    let me = owner.pubkey();
    let blob = TestBlob::new(3, 1, 2);
    for (k, n, size, epochs, error) in [
        (0u8, 3u8, 1024u64, 1u32, SolaDbError::InvalidShardLayout),
        (4, 3, 1024, 1, SolaDbError::InvalidShardLayout),
        (1, 33, 1024, 1, SolaDbError::InvalidShardLayout),
        (2, 3, 1000, 1, SolaDbError::InvalidShardLayout),
        (2, 3, 1024, 0, SolaDbError::InvalidEpochs),
        (2, 3, 1024, MAX_BLOB_EPOCHS + 1, SolaDbError::InvalidEpochs),
    ] {
        let mut ix = env.open_blob_ix(&me, &blob, k, epochs);
        let data = soladb::instruction::OpenBlob {
            args: OpenBlobArgs {
                root: blob.root,
                data_shards: k,
                total_shards: n,
                shard_size: size,
                payload_size: 0,
                epochs,
                max_fee: u64::MAX,
            },
        };
        ix.data = data.data();
        // space follows the declared shard count
        if n <= MAX_SHARDS {
            ix.accounts[3].pubkey = blob_pda(&me, &blob.root);
        }
        assert_error(env.send(&[ix], &[&owner]), soladb_error(error));
    }

    let mut ix = env.open_blob_ix(&me, &blob, 2, 1);
    let args = soladb::instruction::OpenBlob {
        args: OpenBlobArgs {
            root: blob.root,
            data_shards: 2,
            total_shards: 3,
            shard_size: 1024,
            payload_size: 0,
            epochs: 1,
            max_fee: 1,
        },
    };
    ix.data = args.data();
    assert_error(
        env.send(&[ix], &[&owner]),
        soladb_error(SolaDbError::FeeAboveMax),
    );

    let stranger = env.user();
    let ix = env.open_blob_ix(&stranger.pubkey(), &blob, 2, 1);
    assert_error(env.send(&[ix], &[&stranger]), ACCOUNT_NOT_INITIALIZED);
}

#[test]
fn shard_holders_fill_the_slots_and_cool_the_blob() {
    let mut env = Env::new();
    let owner = env.registered_user();
    let blob = TestBlob::new(3, 1, 3);
    let address = env.open_blob(&owner, &blob, 2, 5);
    let (a, b, c) = (env.replicator(), env.replicator(), env.replicator());

    assert_error(
        env.confirm_shard(&a, &address, 3),
        soladb_error(SolaDbError::InvalidShardIndex),
    );
    env.confirm_shard(&a, &address, 0).unwrap();
    assert_error(
        env.confirm_shard(&b, &address, 0),
        soladb_error(SolaDbError::SlotOccupied),
    );
    assert_error(
        env.confirm_shard(&a, &address, 1),
        soladb_error(SolaDbError::AlreadyHolder),
    );
    let state: Blob = env.fetch(&address);
    assert_eq!(state.state, BlobState::Hot, "1 of k = 2");

    env.confirm_shard(&b, &address, 2).unwrap();
    let state: Blob = env.fetch(&address);
    assert_eq!(state.state, BlobState::Cool);
    assert!(state.needs_holders, "slot 1 still vacant");

    env.confirm_shard(&c, &address, 1).unwrap();
    let state: Blob = env.fetch(&address);
    assert_eq!(state.held, 3);
    assert!(!state.needs_holders);
    assert_eq!(state.slots[1].holder, c.pubkey());
    assert_eq!(state.slots[1].proven_at, state.slots[1].claimed_until);
    assert_ne!(
        state.slots[1].challenge_slot, 0,
        "taking a slot opens a possession challenge"
    );
    assert_eq!(
        state.slots[1].challenge_deadline,
        state.slots[1].challenge_slot + CHALLENGE_WINDOW
    );
    assert_eq!(
        env.fetch::<Replicator>(&replicator_pda(&c.pubkey()))
            .confirmations,
        1
    );

    // nobody takes a slot of an expired blob
    let other = TestBlob::new(2, 1, 4);
    let late = env.open_blob(&owner, &other, 1, 1);
    env.warp(EPOCH);
    assert_error(
        env.confirm_shard(&a, &late, 0),
        soladb_error(SolaDbError::BlobExpired),
    );
}

#[test]
fn storage_proofs_answer_challenges_and_unlock_rewards() {
    let mut env = Env::new();
    let owner = env.registered_user();
    let blob = TestBlob::new(3, 8, 5); // 8 segments per shard, 3 shards: proofs of depth 3 and 2
    let address = env.open_blob(&owner, &blob, 2, 10);
    let node = env.replicator();
    env.confirm_shard(&node, &address, 1).unwrap();

    // nothing to claim before a proof; the possession challenge is open
    assert_error(
        env.claim(&node, &address, 1),
        soladb_error(SolaDbError::NothingToClaim),
    );
    let watcher = env.user();
    assert_error(
        env.challenge(&watcher, &address, 1),
        soladb_error(SolaDbError::ChallengeOpen),
    );
    env.answer_open(&node, &address, 1, &blob);
    let proven = env.fetch::<Blob>(&address).slots[1];
    env.claim(&node, &address, 1).ok(); // the seconds since the confirmation
    env.warp(EPOCH / 2);
    assert_error(
        env.claim(&node, &address, 1),
        soladb_error(SolaDbError::NothingToClaim),
    );
    assert!(proven.proven_at >= proven.claimed_until);

    assert_error(
        env.challenge(&watcher, &address, 0),
        soladb_error(SolaDbError::SlotVacant),
    );
    env.challenge(&watcher, &address, 1).unwrap();
    assert_error(
        env.challenge(&watcher, &address, 1),
        soladb_error(SolaDbError::ChallengeOpen),
    );
    let state: Blob = env.fetch(&address);
    let target = state.slots[1].challenge_slot;
    let early = blob.answer(1, 0);
    assert_error(
        env.prove(&node, &address, 1, early),
        soladb_error(SolaDbError::ChallengeNotReady),
    );

    env.warp_slots(CHALLENGE_DELAY_SLOTS + 1);
    let hash = env.set_slot_hashes(&[target + 1, target, target - 1])[1];
    let segment = challenged_segment(&hash, &address, 1, state.shard_segments());

    // the wrong segment, a wrong shard or a truncated proof are rejected
    let wrong = blob.answer(1, (segment + 1) % 8);
    assert_error(
        env.prove(&node, &address, 1, wrong),
        soladb_error(SolaDbError::InvalidProof),
    );
    let other_shard = blob.answer(2, segment);
    assert_error(
        env.prove(&node, &address, 1, other_shard),
        soladb_error(SolaDbError::InvalidProof),
    );
    let mut short = blob.answer(1, segment);
    short.1.pop();
    assert_error(
        env.prove(&node, &address, 1, short),
        soladb_error(SolaDbError::InvalidProof),
    );
    let mut bad_len = blob.answer(1, segment);
    bad_len.0.truncate(512);
    assert_error(
        env.prove(&node, &address, 1, bad_len),
        soladb_error(SolaDbError::InvalidSegment),
    );

    // anyone holding the bytes can answer; the holder is credited
    env.prove(&watcher, &address, 1, blob.answer(1, segment))
        .unwrap();
    let state: Blob = env.fetch(&address);
    assert_eq!(state.slots[1].challenge_slot, 0);
    let elapsed = state.slots[1].proven_at - state.slots[1].claimed_until;
    assert!(elapsed >= EPOCH / 2);

    let reward = state.reward_per_shard_epoch as u128 * elapsed as u128 / EPOCH as u128;
    let before = env.balance(&node.pubkey());
    env.claim(&node, &address, 1).unwrap();
    assert_eq!(env.balance(&node.pubkey()), before + reward as u64 - 5_000);
    assert_eq!(
        env.fetch::<Replicator>(&replicator_pda(&node.pubkey()))
            .lamports_earned,
        reward as u64
    );
    assert_error(
        env.claim(&node, &address, 1),
        soladb_error(SolaDbError::NothingToClaim),
    );
    assert_error(
        env.claim(&watcher, &address, 1),
        ACCOUNT_NOT_INITIALIZED, // not a replicator
    );
}

#[test]
fn an_unanswered_challenge_frees_the_slot_and_pays_a_bounty() {
    let mut env = Env::new();
    let owner = env.registered_user();
    let blob = TestBlob::new(2, 2, 6);
    let address = env.open_blob(&owner, &blob, 1, 4);
    let (lazy, fresh) = (env.replicator(), env.replicator());
    // a node confirms without the bytes: it cannot answer its possession challenge
    env.confirm_shard(&lazy, &address, 0).unwrap();
    env.warp(EPOCH);

    let reporter = env.user();
    let target = env.fetch::<Blob>(&address).slots[0].challenge_slot;
    assert_error(
        env.fail(&reporter, &address, 0),
        soladb_error(SolaDbError::ChallengeStillOpen),
    );
    env.warp_slots(CHALLENGE_DELAY_SLOTS + CHALLENGE_WINDOW + 1);
    env.set_slot_hashes(&[target - 1, target, target + 1]);
    assert_error(
        env.prove(&lazy, &address, 0, blob.answer(0, 0)),
        soladb_error(SolaDbError::ChallengeExpired),
    );

    let state: Blob = env.fetch(&address);
    let now = env.svm.get_sysvar::<Clock>().unix_timestamp;
    let forfeited = state.reward_per_shard_epoch as u128
        * (now - state.slots[0].claimed_until) as u128
        / EPOCH as u128;
    let bounty = (forfeited * BOUNTY_BPS as u128 / 10_000) as u64;
    let before = env.balance(&reporter.pubkey());
    env.fail(&reporter, &address, 0).unwrap();
    assert_eq!(env.balance(&reporter.pubkey()), before + bounty - 5_000);

    let state: Blob = env.fetch(&address);
    assert!(state.slots[0].is_vacant());
    assert_eq!(state.held, 0);
    assert_eq!(state.state, BlobState::Hot);
    assert!(state.needs_holders);
    // another node rebuilds the shard and takes the slot (and proves it holds it)
    env.confirm_shard(&fresh, &address, 0).unwrap();
    env.answer_open(&fresh, &address, 0, &blob);
    assert_eq!(env.fetch::<Blob>(&address).state, BlobState::Cool);
}

#[test]
fn challenges_respect_the_cooldown() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let mut params = env.params();
    params.challenge_cooldown = 3_600;
    let update = ix(
        soladb::instruction::UpdateConfig { params },
        soladb::accounts::AdminOnly {
            admin: admin.pubkey(),
            config: config_pda(),
        },
    );
    env.send(&[update], &[&admin]).unwrap();

    let owner = env.registered_user();
    let blob = TestBlob::new(1, 1, 7);
    let address = env.open_blob(&owner, &blob, 1, 2);
    let node = env.replicator();
    env.confirm_shard(&node, &address, 0).unwrap();
    env.answer_open(&node, &address, 0, &blob);
    assert_error(
        env.challenge(&owner, &address, 0),
        soladb_error(SolaDbError::ChallengeCooldown),
    );
    env.warp(3_600);
    let segment = env.challenge_ready(&owner, &address, 0);
    env.prove(&node, &address, 0, blob.answer(0, segment))
        .unwrap();
    assert_error(
        env.challenge(&owner, &address, 0),
        soladb_error(SolaDbError::ChallengeCooldown),
    );
}

#[test]
fn rewards_stop_at_expiry_and_the_owner_recovers_the_rest() {
    let mut env = Env::new();
    let owner = env.registered_user();
    let blob = TestBlob::new(2, 1, 8);
    let address = env.open_blob(&owner, &blob, 1, 2);
    let node = env.replicator();
    env.confirm_shard(&node, &address, 0).unwrap();
    env.answer_open(&node, &address, 0, &blob);

    // a proof after expiry (inside the grace epoch) unlocks everything up to expiry
    env.warp(2 * EPOCH + EPOCH / 2);
    let segment = env.challenge_ready(&node, &address, 0);
    env.prove(&node, &address, 0, blob.answer(0, segment))
        .unwrap();
    let state: Blob = env.fetch(&address);
    let full = state.reward_between(EPOCH, state.slots[0].claimed_until, state.expires_at);
    let before = env.balance(&node.pubkey());
    env.claim(&node, &address, 0).unwrap();
    assert_eq!(env.balance(&node.pubkey()), before + full - 5_000);

    // slot 1 was never held: its escrow goes back with the rent
    assert_error(
        env.close_blob(&owner, &address),
        soladb_error(SolaDbError::BlobNotClosable),
    );
    env.warp(EPOCH);
    let locked = env.balance(&address);
    let before = env.balance(&owner.pubkey());
    env.close_blob(&owner, &address).unwrap();
    assert!(!env.exists(&address));
    assert_eq!(env.balance(&owner.pubkey()), before + locked - 5_000);
}

#[test]
fn abandoned_blobs_close_after_the_abort_delay() {
    let mut env = Env::new();
    let owner = env.registered_user();
    let blob = TestBlob::new(2, 1, 9);
    let address = env.open_blob(&owner, &blob, 1, 3);
    assert_error(
        env.close_blob(&owner, &address),
        soladb_error(SolaDbError::BlobNotClosable),
    );
    let stranger = env.registered_user();
    env.warp(DIRECT_ABORT_DELAY);
    assert_error(
        env.close_blob(&stranger, &address),
        soladb_error(SolaDbError::NotOwner),
    );
    env.close_blob(&owner, &address).unwrap();

    // with a holder it waits for expiry
    let other = TestBlob::new(2, 1, 10);
    let held = env.open_blob(&owner, &other, 1, 3);
    let node = env.replicator();
    env.confirm_shard(&node, &held, 1).unwrap();
    env.warp(DIRECT_ABORT_DELAY);
    assert_error(
        env.close_blob(&owner, &held),
        soladb_error(SolaDbError::BlobNotClosable),
    );
}

#[test]
fn extending_a_blob_prepays_more_epochs_at_its_rate() {
    let mut env = Env::new();
    let owner = env.registered_user();
    let blob = TestBlob::new(2, 2, 11);
    let address = env.open_blob(&owner, &blob, 1, 2);
    let state: Blob = env.fetch(&address);
    let extend = |epochs: u32, max_fee: u64, treasury: Pubkey| {
        ix(
            soladb::instruction::ExtendBlob { epochs, max_fee },
            soladb::accounts::ExtendBlob {
                owner: owner.pubkey(),
                blob: address,
                config: config_pda(),
                treasury,
                system_program: system_program::ID,
            },
        )
    };
    let escrow = state.reward_per_shard_epoch * 2 * 3;
    let protocol = escrow * 1_000 / 9_000;
    assert_error(
        env.send(&[extend(3, escrow + protocol - 1, env.treasury)], &[&owner]),
        soladb_error(SolaDbError::FeeAboveMax),
    );
    let blob_before = env.balance(&address);
    env.send(&[extend(3, u64::MAX, env.treasury)], &[&owner])
        .unwrap();
    let after: Blob = env.fetch(&address);
    assert_eq!(after.epochs, 5);
    assert_eq!(after.expires_at, state.expires_at + 3 * EPOCH);
    assert_eq!(env.balance(&address), blob_before + escrow);

    env.warp(5 * EPOCH);
    assert_error(
        env.send(&[extend(1, u64::MAX, env.treasury)], &[&owner]),
        soladb_error(SolaDbError::BlobExpired),
    );
}

#[test]
fn merkle_helpers_match_the_spec() {
    use soladb::state::{fold_proof, leaf_hash, merkle_depth, node_hash};
    assert_eq!(merkle_depth(1), 0);
    assert_eq!(merkle_depth(2), 1);
    assert_eq!(merkle_depth(3), 2);
    assert_eq!(merkle_depth(1024), 10);
    assert_eq!(merkle_depth(1025), 11);
    let segment = [9u8; 1024];
    assert_eq!(leaf_hash(&segment), leaf(&segment));
    assert_eq!(node_hash(&[1; 32], &[2; 32]), node(&[1; 32], &[2; 32]));
    // every index of a padded 5-leaf tree folds back to its root
    let leaves: Vec<[u8; 32]> = (0..5u8).map(|i| leaf(&[i; 1024])).collect();
    let root = root_of(&leaves);
    for (i, l) in leaves.iter().enumerate() {
        assert_eq!(fold_proof(*l, i as u64, &proof_of(&leaves, i)), root);
    }
}

#[test]
fn a_skipped_challenge_slot_uses_the_next_produced_slot() {
    let mut env = Env::new();
    let owner = env.registered_user();
    let blob = TestBlob::new(2, 8, 12);
    let address = env.open_blob(&owner, &blob, 1, 3);
    let node = env.replicator();
    env.confirm_shard(&node, &address, 0).unwrap();
    let state: Blob = env.fetch(&address);
    let target = state.slots[0].challenge_slot;

    // the target slot was skipped and nothing after it is recorded yet: not answerable yet
    env.warp_slots(CHALLENGE_DELAY_SLOTS + 1);
    env.set_slot_hashes(&[target - 2, target - 1]);
    assert_error(
        env.prove(&node, &address, 0, blob.answer(0, 0)),
        soladb_error(SolaDbError::ChallengeNotReady),
    );

    // the first produced slot after it decides the segment, for everyone
    env.warp_slots(3);
    let hashes = env.set_slot_hashes(&[target - 1, target + 2, target + 4]);
    let segment = challenged_segment(&hashes[1], &address, 0, state.shard_segments());
    env.prove(&node, &address, 0, blob.answer(0, segment))
        .unwrap();
    assert_eq!(env.fetch::<Blob>(&address).slots[0].challenge_slot, 0);
}

#[test]
fn a_challenge_window_without_blocks_is_voided_not_slashed() {
    let mut env = Env::new();
    let owner = env.registered_user();
    let blob = TestBlob::new(2, 1, 13);
    let address = env.open_blob(&owner, &blob, 1, 3);
    let node = env.replicator();
    env.confirm_shard(&node, &address, 0).unwrap();
    let state: Blob = env.fetch(&address);
    let (target, deadline) = (
        state.slots[0].challenge_slot,
        state.slots[0].challenge_deadline,
    );
    env.warp_slots(CHALLENGE_DELAY_SLOTS + CHALLENGE_WINDOW + 5);

    // SlotHashes reaches back before the target, and no block landed in [target, deadline]
    env.set_slot_hashes(&[target - 3, deadline + 2]);
    let reporter = env.user();
    let before = env.balance(&reporter.pubkey());
    env.fail(&reporter, &address, 0).unwrap();
    let after: Blob = env.fetch(&address);
    assert_eq!(
        after.slots[0].holder,
        node.pubkey(),
        "the holder keeps its slot"
    );
    assert_eq!(after.slots[0].challenge_slot, 0);
    assert_eq!(after.held, 1);
    assert_eq!(env.balance(&reporter.pubkey()), before - 5_000, "no bounty");

    // a single block at the deadline gave a hash, but no block was left to carry the proof
    env.challenge(&owner, &address, 0).unwrap();
    let state: Blob = env.fetch(&address);
    let (target, deadline) = (
        state.slots[0].challenge_slot,
        state.slots[0].challenge_deadline,
    );
    env.warp_slots(CHALLENGE_DELAY_SLOTS + CHALLENGE_WINDOW + 5);
    env.set_slot_hashes(&[target - 3, deadline, deadline + 3]);
    env.fail(&reporter, &address, 0).unwrap();
    assert_eq!(
        env.fetch::<Blob>(&address).slots[0].holder,
        node.pubkey(),
        "voided: the holder could not have answered"
    );

    // a window that had blocks the holder ignored is still slashed
    env.challenge(&owner, &address, 0).unwrap();
    let target = env.fetch::<Blob>(&address).slots[0].challenge_slot;
    env.warp_slots(CHALLENGE_DELAY_SLOTS + CHALLENGE_WINDOW + 5);
    env.set_slot_hashes(&[target - 1, target, target + 1]);
    env.fail(&reporter, &address, 0).unwrap();
    assert!(env.fetch::<Blob>(&address).slots[0].is_vacant());
}

#[test]
fn a_node_cannot_squat_a_slot_without_the_bytes() {
    let mut env = Env::new();
    let owner = env.registered_user();
    let blob = TestBlob::new(3, 4, 14);
    let address = env.open_blob(&owner, &blob, 2, 3);
    let (squatter, honest) = (env.replicator(), env.replicator());

    // the squatter grabs slot 2 first, but has no bytes to answer with
    env.confirm_shard(&squatter, &address, 2).unwrap();
    assert_error(
        env.confirm_shard(&honest, &address, 2),
        soladb_error(SolaDbError::SlotOccupied),
    );
    let target = env.fetch::<Blob>(&address).slots[2].challenge_slot;
    env.warp_slots(CHALLENGE_DELAY_SLOTS + 1);
    env.set_slot_hashes(&[target - 1, target, target + 1]);
    let wrong = blob.answer(1, 0); // any data it might have is not shard 2
    assert_error(
        env.prove(&squatter, &address, 2, wrong),
        soladb_error(SolaDbError::InvalidProof),
    );

    // after the window anyone frees the slot, and the honest node takes it
    env.warp_slots(CHALLENGE_WINDOW);
    let reporter = env.user();
    env.fail(&reporter, &address, 2).unwrap();
    env.confirm_shard(&honest, &address, 2).unwrap();
    env.answer_open(&honest, &address, 2, &blob);
    let state: Blob = env.fetch(&address);
    assert_eq!(state.slots[2].holder, honest.pubkey());
    assert_eq!(state.slots[2].challenge_slot, 0);
}
