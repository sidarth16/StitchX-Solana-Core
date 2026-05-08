use {
    anchor_lang::{
        prelude::Pubkey,
        prelude::Rent,
        AccountDeserialize,
        InstructionData,
        solana_program::{
            instruction::{AccountMeta, Instruction},
            program_pack::Pack,
            system_instruction,
        },
        solana_program::sysvar::SysvarId,
    },
    litesvm::{types::TransactionResult, LiteSVM},
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    stitchx_sid::{
        self, COMPOSITION_SEED, LOCK_RECORD_SEED, SCENE_KEY_BYTES, USER_STATE_SEED,
    },
};

#[test]
fn test_initialize_and_lock_flow() {
    let (mut svm, payer, program_id, user_state) = setup_env();
    let assets = create_assets(&mut svm, &payer, 2);
    let composition = lock_composition(&mut svm, &program_id, &payer, user_state, &assets, 7);

    let user_state_account: stitchx_sid::UserState = fetch_account(&svm, user_state);
    assert_eq!(user_state_account.authority, payer.pubkey());
    assert_eq!(user_state_account.composition_count, 1);

    let composition_account: stitchx_sid::Composition = fetch_account(&svm, composition.composition);
    assert_eq!(composition_account.owner, payer.pubkey());
    assert_eq!(composition_account.comp_id, composition.comp_id);
    assert_eq!(composition_account.asset_count, assets.len() as u8);
    assert_eq!(composition_account.asset_mints[0], assets[0].mint);
    assert_eq!(composition_account.asset_mints[1], assets[1].mint);
    assert_eq!(composition_account.scene_key, composition.scene_key);
    assert_eq!(composition_account.status, stitchx_sid::CompositionStatus::Locked);
    assert_eq!(composition_account.composition_mint, Pubkey::default());

    let lock_record: stitchx_sid::LockRecord = fetch_account(&svm, composition.lock_records[0]);
    assert_eq!(lock_record.asset_mint, assets[0].mint);
    assert_eq!(lock_record.composition, composition.composition);
    assert_eq!(lock_record.owner, payer.pubkey());
}

#[test]
fn test_mint_burn_and_unlock_flow() {
    let (mut svm, payer, program_id, user_state) = setup_env();
    let assets = create_assets(&mut svm, &payer, 2);
    let composition = lock_composition(&mut svm, &program_id, &payer, user_state, &assets, 11);
    let snapshot = mint_snapshot_nft(&mut svm, &program_id, &payer, composition.composition);

    let composition_account: stitchx_sid::Composition = fetch_account(&svm, composition.composition);
    assert_eq!(composition_account.status, stitchx_sid::CompositionStatus::Minted);
    assert_eq!(composition_account.composition_mint, snapshot.composition_mint);

    send(
        &mut svm,
        &program_id,
        &payer,
        vec![
            AccountMeta::new(composition.composition, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(snapshot.composition_mint, false),
            AccountMeta::new(snapshot.owner_ata, false),
            AccountMeta::new_readonly(anchor_spl::token::ID, false),
            AccountMeta::new(composition.lock_records[0], false),
            AccountMeta::new(composition.lock_records[1], false),
        ],
        stitchx_sid::instruction::BurnAndUnlock {}.data(),
        &[&payer],
    );

    let composition_account: stitchx_sid::Composition = fetch_account(&svm, composition.composition);
    assert_eq!(composition_account.status, stitchx_sid::CompositionStatus::Unlocked);
    assert_account_closed(&svm, composition.lock_records[0]);
    assert_account_closed(&svm, composition.lock_records[1]);
}

#[test]
fn test_dismantle_flow() {
    let (mut svm, payer, program_id, user_state) = setup_env();
    let assets = create_assets(&mut svm, &payer, 2);
    let composition = lock_composition(&mut svm, &program_id, &payer, user_state, &assets, 19);

    send(
        &mut svm,
        &program_id,
        &payer,
        vec![
            AccountMeta::new(composition.composition, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(composition.lock_records[0], false),
            AccountMeta::new(composition.lock_records[1], false),
        ],
        stitchx_sid::instruction::DismantleComposition {}.data(),
        &[&payer],
    );

    let composition_account: stitchx_sid::Composition = fetch_account(&svm, composition.composition);
    assert_eq!(composition_account.status, stitchx_sid::CompositionStatus::Unlocked);
    assert_account_closed(&svm, composition.lock_records[0]);
    assert_account_closed(&svm, composition.lock_records[1]);
}

#[test]
fn test_asset_reuse_is_rejected() {
    let (mut svm, payer, program_id, user_state) = setup_env();
    let assets = create_assets(&mut svm, &payer, 1);
    let first_composition = lock_composition(&mut svm, &program_id, &payer, user_state, &assets, 27);

    let second_user_state: stitchx_sid::UserState = fetch_account(&svm, user_state);
    let second_composition = pda(
        &program_id,
        &[
            COMPOSITION_SEED,
            payer.pubkey().as_ref(),
            &second_user_state.composition_count.to_le_bytes(),
        ],
    );
    let lock_record = pda(
        &program_id,
        &[LOCK_RECORD_SEED, assets[0].mint.as_ref()],
    );

    let result = send_result(
        &mut svm,
        &program_id,
        &payer,
        vec![
            AccountMeta::new(user_state, false),
            AccountMeta::new(second_composition, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(anchor_lang::system_program::ID, false),
            AccountMeta::new(assets[0].token_account, false),
            AccountMeta::new(lock_record, false),
        ],
        stitchx_sid::instruction::LockAndCompose {
            scene_key: [33u8; SCENE_KEY_BYTES],
            asset_mints: vec![assets[0].mint],
        }
        .data(),
        &[&payer],
    );

    assert!(result.is_err());
    assert_account_exists(&svm, first_composition.lock_records[0]);
}

#[test]
fn test_dismantle_rejects_non_owner() {
    let (mut svm, payer, program_id, user_state) = setup_env();
    let assets = create_assets(&mut svm, &payer, 2);
    let composition = lock_composition(&mut svm, &program_id, &payer, user_state, &assets, 41);
    let attacker = Keypair::new();
    svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();

    let result = send_result(
        &mut svm,
        &program_id,
        &payer,
        vec![
            AccountMeta::new(composition.composition, false),
            AccountMeta::new(attacker.pubkey(), true),
        ],
        stitchx_sid::instruction::DismantleComposition {}.data(),
        &[&payer, &attacker],
    );

    assert!(result.is_err());
    let composition_account: stitchx_sid::Composition = fetch_account(&svm, composition.composition);
    assert_eq!(composition_account.status, stitchx_sid::CompositionStatus::Locked);
}

#[test]
fn test_double_dismantle_fails_safely() {
    let (mut svm, payer, program_id, user_state) = setup_env();
    let assets = create_assets(&mut svm, &payer, 2);
    let composition = lock_composition(&mut svm, &program_id, &payer, user_state, &assets, 51);

    send(
        &mut svm,
        &program_id,
        &payer,
        vec![
            AccountMeta::new(composition.composition, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(composition.lock_records[0], false),
            AccountMeta::new(composition.lock_records[1], false),
        ],
        stitchx_sid::instruction::DismantleComposition {}.data(),
        &[&payer],
    );

    let second = send_result(
        &mut svm,
        &program_id,
        &payer,
        vec![
            AccountMeta::new(composition.composition, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(composition.lock_records[0], false),
            AccountMeta::new(composition.lock_records[1], false),
        ],
        stitchx_sid::instruction::DismantleComposition {}.data(),
        &[&payer],
    );

    assert!(second.is_err());
    let composition_account: stitchx_sid::Composition = fetch_account(&svm, composition.composition);
    assert_eq!(composition_account.status, stitchx_sid::CompositionStatus::Unlocked);
}

#[test]
fn test_invalid_remaining_accounts_ordering_fails() {
    let (mut svm, payer, program_id, user_state) = setup_env();
    let assets = create_assets(&mut svm, &payer, 1);
    let comp_id = fetch_account::<stitchx_sid::UserState>(&svm, user_state).composition_count;
    let composition = pda(
        &program_id,
        &[
            COMPOSITION_SEED,
            payer.pubkey().as_ref(),
            &comp_id.to_le_bytes(),
        ],
    );
    let lock_record = pda(&program_id, &[LOCK_RECORD_SEED, assets[0].mint.as_ref()]);

    let result = send_result(
        &mut svm,
        &program_id,
        &payer,
        vec![
            AccountMeta::new(user_state, false),
            AccountMeta::new(composition, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(anchor_lang::system_program::ID, false),
            AccountMeta::new(lock_record, false),
            AccountMeta::new(assets[0].token_account, false),
        ],
        stitchx_sid::instruction::LockAndCompose {
            scene_key: [61u8; SCENE_KEY_BYTES],
            asset_mints: vec![assets[0].mint],
        }
        .data(),
        &[&payer],
    );

    assert!(result.is_err());
}

#[test]
fn test_wrong_lock_pda_fails() {
    let (mut svm, payer, program_id, user_state) = setup_env();
    let assets = create_assets(&mut svm, &payer, 1);
    let comp_id = fetch_account::<stitchx_sid::UserState>(&svm, user_state).composition_count;
    let composition = pda(
        &program_id,
        &[
            COMPOSITION_SEED,
            payer.pubkey().as_ref(),
            &comp_id.to_le_bytes(),
        ],
    );
    let wrong_lock_record = Pubkey::new_unique();

    let result = send_result(
        &mut svm,
        &program_id,
        &payer,
        vec![
            AccountMeta::new(user_state, false),
            AccountMeta::new(composition, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(anchor_lang::system_program::ID, false),
            AccountMeta::new(assets[0].token_account, false),
            AccountMeta::new(wrong_lock_record, false),
        ],
        stitchx_sid::instruction::LockAndCompose {
            scene_key: [63u8; SCENE_KEY_BYTES],
            asset_mints: vec![assets[0].mint],
        }
        .data(),
        &[&payer],
    );

    assert!(result.is_err());
}

#[test]
fn test_wrong_token_owner_fails() {
    let (mut svm, payer, program_id, user_state) = setup_env();
    let asset = create_asset_token(&mut svm, &payer);
    let attacker = Keypair::new();
    svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();
    let attacker_token_account = create_token_account_with_owner(
        &mut svm,
        &payer,
        asset.mint,
        &attacker.pubkey(),
    );
    let comp_id = fetch_account::<stitchx_sid::UserState>(&svm, user_state).composition_count;
    let composition = pda(
        &program_id,
        &[
            COMPOSITION_SEED,
            payer.pubkey().as_ref(),
            &comp_id.to_le_bytes(),
        ],
    );
    let lock_record = pda(&program_id, &[LOCK_RECORD_SEED, asset.mint.as_ref()]);

    let result = send_result(
        &mut svm,
        &program_id,
        &payer,
        vec![
            AccountMeta::new(user_state, false),
            AccountMeta::new(composition, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(anchor_lang::system_program::ID, false),
            AccountMeta::new(attacker_token_account, false),
            AccountMeta::new(lock_record, false),
        ],
        stitchx_sid::instruction::LockAndCompose {
            scene_key: [65u8; SCENE_KEY_BYTES],
            asset_mints: vec![asset.mint],
        }
        .data(),
        &[&payer],
    );

    assert!(result.is_err());
}

#[test]
fn test_token_mint_mismatch_fails() {
    let (mut svm, payer, program_id, user_state) = setup_env();
    let asset_a = create_asset_token(&mut svm, &payer);
    let asset_b = create_asset_token(&mut svm, &payer);
    let comp_id = fetch_account::<stitchx_sid::UserState>(&svm, user_state).composition_count;
    let composition = pda(
        &program_id,
        &[
            COMPOSITION_SEED,
            payer.pubkey().as_ref(),
            &comp_id.to_le_bytes(),
        ],
    );
    let lock_record = pda(&program_id, &[LOCK_RECORD_SEED, asset_a.mint.as_ref()]);

    let result = send_result(
        &mut svm,
        &program_id,
        &payer,
        vec![
            AccountMeta::new(user_state, false),
            AccountMeta::new(composition, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(anchor_lang::system_program::ID, false),
            AccountMeta::new(asset_b.token_account, false),
            AccountMeta::new(lock_record, false),
        ],
        stitchx_sid::instruction::LockAndCompose {
            scene_key: [67u8; SCENE_KEY_BYTES],
            asset_mints: vec![asset_a.mint],
        }
        .data(),
        &[&payer],
    );

    assert!(result.is_err());
}

fn setup_env() -> (LiteSVM, Keypair, Pubkey, Pubkey) {
    let program_id = stitchx_sid::id();
    let payer = Keypair::new();
    let mut svm = LiteSVM::new();
    let bytes = include_bytes!("../../../target/deploy/stitchx_sid.so");
    svm.add_program(program_id, bytes).unwrap();
    svm.airdrop(&payer.pubkey(), 2_000_000_000).unwrap();

    let user_state = pda(&program_id, &[USER_STATE_SEED, payer.pubkey().as_ref()]);
    send(
        &mut svm,
        &program_id,
        &payer,
        vec![
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(user_state, false),
            AccountMeta::new_readonly(anchor_lang::system_program::ID, false),
        ],
        stitchx_sid::instruction::InitializeUser {}.data(),
        &[&payer],
    );

    let user_state_account: stitchx_sid::UserState = fetch_account(&svm, user_state);
    assert_eq!(user_state_account.authority, payer.pubkey());
    assert_eq!(user_state_account.composition_count, 0);

    (svm, payer, program_id, user_state)
}

fn lock_composition(
    svm: &mut LiteSVM,
    program_id: &Pubkey,
    payer: &Keypair,
    user_state: Pubkey,
    assets: &[AssetFixture],
    scene_seed: u8,
) -> CompositionFixture {
    let user_state_account: stitchx_sid::UserState = fetch_account(svm, user_state);
    let comp_id = user_state_account.composition_count;
    let composition = pda(
        program_id,
        &[
            COMPOSITION_SEED,
            payer.pubkey().as_ref(),
            &comp_id.to_le_bytes(),
        ],
    );
    let scene_key = [scene_seed; SCENE_KEY_BYTES];
    let asset_mints: Vec<Pubkey> = assets.iter().map(|asset| asset.mint).collect();
    let lock_records: Vec<Pubkey> = asset_mints
        .iter()
        .map(|mint| pda(program_id, &[LOCK_RECORD_SEED, mint.as_ref()]))
        .collect();

    let mut metas = vec![
        AccountMeta::new(user_state, false),
        AccountMeta::new(composition, false),
        AccountMeta::new(payer.pubkey(), true),
        AccountMeta::new_readonly(anchor_lang::system_program::ID, false),
    ];
    for (asset, lock_record) in assets.iter().zip(lock_records.iter()) {
        metas.push(AccountMeta::new(asset.token_account, false));
        metas.push(AccountMeta::new(*lock_record, false));
    }

    send(
        svm,
        program_id,
        payer,
        metas,
        stitchx_sid::instruction::LockAndCompose {
            scene_key,
            asset_mints: asset_mints.clone(),
        }
        .data(),
        &[&payer],
    );

    CompositionFixture {
        composition,
        comp_id,
        scene_key,
        lock_records,
    }
}

fn mint_snapshot_nft(
    svm: &mut LiteSVM,
    program_id: &Pubkey,
    payer: &Keypair,
    composition: Pubkey,
) -> SnapshotFixture {
    let composition_mint = Keypair::new();
    let owner_ata = spl_ata_address(&payer.pubkey(), &composition_mint.pubkey());

    send(
        svm,
        program_id,
        payer,
        vec![
            AccountMeta::new(composition, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(composition_mint.pubkey(), true),
            AccountMeta::new(owner_ata, false),
            AccountMeta::new_readonly(anchor_spl::token::ID, false),
            AccountMeta::new_readonly(anchor_spl::associated_token::ID, false),
            AccountMeta::new_readonly(anchor_lang::system_program::ID, false),
            AccountMeta::new_readonly(Rent::id(), false),
        ],
        stitchx_sid::instruction::MintComposition {}.data(),
        &[&payer, &composition_mint],
    );

    SnapshotFixture {
        composition_mint: composition_mint.pubkey(),
        owner_ata,
    }
}

fn send(
    svm: &mut LiteSVM,
    program_id: &Pubkey,
    payer: &Keypair,
    metas: Vec<AccountMeta>,
    data: Vec<u8>,
    signers: &[&Keypair],
) {
    let result = send_result(svm, program_id, payer, metas, data, signers);
    result.expect("transaction should succeed");
}

fn send_result(
    svm: &mut LiteSVM,
    program_id: &Pubkey,
    payer: &Keypair,
    metas: Vec<AccountMeta>,
    data: Vec<u8>,
    signers: &[&Keypair],
) -> TransactionResult {
    let instruction = Instruction::new_with_bytes(*program_id, &data, metas);
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[instruction], Some(&payer.pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
    svm.send_transaction(tx)
}

fn fetch_account<T: AccountDeserialize>(svm: &LiteSVM, address: Pubkey) -> T {
    let account = svm.get_account(&address).expect("account must exist");
    let mut data = account.data.as_slice();
    T::try_deserialize(&mut data).expect("account must deserialize")
}

fn assert_account_closed(svm: &LiteSVM, address: Pubkey) {
    if let Some(account) = svm.get_account(&address) {
        assert_eq!(account.lamports, 0);
        assert!(account.data.is_empty());
    }
}

fn assert_account_exists(svm: &LiteSVM, address: Pubkey) {
    assert!(svm.get_account(&address).is_some());
}

fn pda(program_id: &Pubkey, seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, program_id).0
}

fn spl_ata_address(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    let token_program = anchor_spl::token::ID;
    let associated_token_program = anchor_spl::associated_token::ID;
    Pubkey::find_program_address(
        &[owner.as_ref(), token_program.as_ref(), mint.as_ref()],
        &associated_token_program,
    )
    .0
}

#[derive(Clone, Copy)]
struct AssetFixture {
    mint: Pubkey,
    token_account: Pubkey,
}

struct CompositionFixture {
    composition: Pubkey,
    comp_id: u64,
    scene_key: [u8; SCENE_KEY_BYTES],
    lock_records: Vec<Pubkey>,
}

struct SnapshotFixture {
    composition_mint: Pubkey,
    owner_ata: Pubkey,
}

fn create_assets(svm: &mut LiteSVM, payer: &Keypair, count: usize) -> Vec<AssetFixture> {
    (0..count).map(|_| create_asset_token(svm, payer)).collect()
}

fn create_asset_token(svm: &mut LiteSVM, payer: &Keypair) -> AssetFixture {
    let mint = Keypair::new();
    let token_account = Keypair::new();
    let token_program = anchor_spl::token::ID;

    send(
        svm,
        &anchor_lang::system_program::ID,
        payer,
        vec![
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(mint.pubkey(), true),
            AccountMeta::new_readonly(anchor_lang::system_program::ID, false),
        ],
        system_instruction::create_account(
            &payer.pubkey(),
            &mint.pubkey(),
            svm.minimum_balance_for_rent_exemption(anchor_spl::token::spl_token::state::Mint::LEN),
            anchor_spl::token::spl_token::state::Mint::LEN as u64,
            &token_program,
        )
        .data,
        &[payer, &mint],
    );

    send(
        svm,
        &token_program,
        payer,
        vec![AccountMeta::new(mint.pubkey(), false)],
        anchor_spl::token::spl_token::instruction::initialize_mint2(
            &token_program,
            &mint.pubkey(),
            &payer.pubkey(),
            None,
            0,
        )
        .unwrap()
        .data,
        &[payer],
    );

    send(
        svm,
        &anchor_lang::system_program::ID,
        payer,
        vec![
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(token_account.pubkey(), true),
            AccountMeta::new_readonly(anchor_lang::system_program::ID, false),
        ],
        system_instruction::create_account(
            &payer.pubkey(),
            &token_account.pubkey(),
            svm.minimum_balance_for_rent_exemption(anchor_spl::token::spl_token::state::Account::LEN),
            anchor_spl::token::spl_token::state::Account::LEN as u64,
            &token_program,
        )
        .data,
        &[payer, &token_account],
    );

    send(
        svm,
        &token_program,
        payer,
        vec![
            AccountMeta::new(token_account.pubkey(), false),
            AccountMeta::new_readonly(mint.pubkey(), false),
        ],
        anchor_spl::token::spl_token::instruction::initialize_account3(
            &token_program,
            &token_account.pubkey(),
            &mint.pubkey(),
            &payer.pubkey(),
        )
        .unwrap()
        .data,
        &[payer],
    );

    send(
        svm,
        &token_program,
        payer,
        vec![
            AccountMeta::new(mint.pubkey(), false),
            AccountMeta::new(token_account.pubkey(), false),
            AccountMeta::new_readonly(payer.pubkey(), true),
        ],
        anchor_spl::token::spl_token::instruction::mint_to(
            &token_program,
            &mint.pubkey(),
            &token_account.pubkey(),
            &payer.pubkey(),
            &[],
            1,
        )
        .unwrap()
        .data,
        &[payer],
    );

    AssetFixture {
        mint: mint.pubkey(),
        token_account: token_account.pubkey(),
    }
}

fn create_token_account_with_owner(
    svm: &mut LiteSVM,
    payer: &Keypair,
    mint: Pubkey,
    owner: &Pubkey,
) -> Pubkey {
    let token_account = Keypair::new();
    let token_program = anchor_spl::token::ID;

    send(
        svm,
        &anchor_lang::system_program::ID,
        payer,
        vec![
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(token_account.pubkey(), true),
            AccountMeta::new_readonly(anchor_lang::system_program::ID, false),
        ],
        system_instruction::create_account(
            &payer.pubkey(),
            &token_account.pubkey(),
            svm.minimum_balance_for_rent_exemption(anchor_spl::token::spl_token::state::Account::LEN),
            anchor_spl::token::spl_token::state::Account::LEN as u64,
            &token_program,
        )
        .data,
        &[payer, &token_account],
    );

    send(
        svm,
        &token_program,
        payer,
        vec![
            AccountMeta::new(token_account.pubkey(), false),
            AccountMeta::new_readonly(mint, false),
        ],
        anchor_spl::token::spl_token::instruction::initialize_account3(
            &token_program,
            &token_account.pubkey(),
            &mint,
            owner,
        )
        .unwrap()
        .data,
        &[payer],
    );

    send(
        svm,
        &token_program,
        payer,
        vec![
            AccountMeta::new(mint, false),
            AccountMeta::new(token_account.pubkey(), false),
            AccountMeta::new_readonly(payer.pubkey(), true),
        ],
        anchor_spl::token::spl_token::instruction::mint_to(
            &token_program,
            &mint,
            &token_account.pubkey(),
            &payer.pubkey(),
            &[],
            1,
        )
        .unwrap()
        .data,
        &[payer],
    );

    token_account.pubkey()
}
