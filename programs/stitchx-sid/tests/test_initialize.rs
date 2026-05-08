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
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    stitchx_sid::{
        self,
        COMPOSITION_SEED, LOCK_RECORD_SEED, SCENE_KEY_BYTES, USER_STATE_SEED,
    },
};

#[test]
fn test_initialize_lock_and_mint_flow() {
    let program_id = stitchx_sid::id();
    let payer = Keypair::new();
    let mut svm = LiteSVM::new();
    let bytes = include_bytes!("../../../target/deploy/stitchx_sid.so");
    svm.add_program(program_id, bytes).unwrap();
    svm.airdrop(&payer.pubkey(), 2_000_000_000).unwrap();

    let user_state = pda(&program_id, &[USER_STATE_SEED, payer.pubkey().as_ref()]);
    let comp_id = 0u64;
    let composition = pda(
        &program_id,
        &[
            COMPOSITION_SEED,
            payer.pubkey().as_ref(),
            &comp_id.to_le_bytes(),
        ],
    );
    let asset_a = create_asset_token(&mut svm, &payer);
    let asset_b = create_asset_token(&mut svm, &payer);
    let asset_mints = vec![asset_a.mint, asset_b.mint];
    let asset_token_accounts = vec![asset_a.token_account, asset_b.token_account];
    assert_asset_token(&svm, asset_token_accounts[0], asset_mints[0], payer.pubkey());
    assert_asset_token(&svm, asset_token_accounts[1], asset_mints[1], payer.pubkey());
    let scene_key = [7u8; SCENE_KEY_BYTES];
    let lock_records: Vec<Pubkey> = asset_mints
        .iter()
        .map(|mint| pda(&program_id, &[LOCK_RECORD_SEED, mint.as_ref()]))
        .collect();

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

    send(
        &mut svm,
        &program_id,
        &payer,
        vec![
            AccountMeta::new(user_state, false),
            AccountMeta::new(composition, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(anchor_lang::system_program::ID, false),
            AccountMeta::new(asset_token_accounts[0], false),
            AccountMeta::new(lock_records[0], false),
            AccountMeta::new(asset_token_accounts[1], false),
            AccountMeta::new(lock_records[1], false),
        ],
        stitchx_sid::instruction::LockAndCompose {
            scene_key,
            asset_mints: asset_mints.clone(),
        }
        .data(),
        &[&payer],
    );

    let user_state_account: stitchx_sid::UserState = fetch_account(&svm, user_state);
    assert_eq!(user_state_account.composition_count, 1);

    let composition_account: stitchx_sid::Composition = fetch_account(&svm, composition);
    assert_eq!(composition_account.owner, payer.pubkey());
    assert_eq!(composition_account.comp_id, comp_id);
    assert_eq!(composition_account.asset_count, asset_mints.len() as u8);
    assert_eq!(composition_account.scene_key, scene_key);
    assert_eq!(composition_account.status, stitchx_sid::CompositionStatus::Locked);

    let first_lock_record: stitchx_sid::LockRecord = fetch_account(&svm, lock_records[0]);
    assert_eq!(first_lock_record.asset_mint, asset_mints[0]);
    assert_eq!(first_lock_record.composition, composition);
    assert_eq!(first_lock_record.owner, payer.pubkey());

    let composition_mint = Keypair::new();
    let owner_ata = spl_ata_address(&payer.pubkey(), &composition_mint.pubkey());

    send(
        &mut svm,
        &program_id,
        &payer,
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

    let composition_account: stitchx_sid::Composition = fetch_account(&svm, composition);
    assert_eq!(composition_account.status, stitchx_sid::CompositionStatus::Minted);
    assert_eq!(composition_account.composition_mint, composition_mint.pubkey());
}

fn send(
    svm: &mut LiteSVM,
    program_id: &Pubkey,
    payer: &Keypair,
    metas: Vec<AccountMeta>,
    data: Vec<u8>,
    signers: &[&Keypair],
) {
    let instruction = Instruction::new_with_bytes(*program_id, &data, metas);
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[instruction], Some(&payer.pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
    svm.send_transaction(tx).unwrap();
}

fn fetch_account<T: AccountDeserialize>(svm: &LiteSVM, address: Pubkey) -> T {
    let account = svm.get_account(&address).expect("account must exist");
    let mut data = account.data.as_slice();
    T::try_deserialize(&mut data).expect("account must deserialize")
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

struct AssetFixture {
    mint: Pubkey,
    token_account: Pubkey,
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
        vec![
            AccountMeta::new(mint.pubkey(), false),
        ],
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

fn assert_asset_token(svm: &LiteSVM, token_account: Pubkey, mint: Pubkey, owner: Pubkey) {
    let account = svm.get_account(&token_account).expect("token account must exist");
    let mut data = account.data.as_slice();
    let parsed = anchor_spl::token::spl_token::state::Account::unpack(&mut data).unwrap();
    assert_eq!(parsed.owner, owner);
    assert_eq!(parsed.mint, mint);
    assert_eq!(parsed.amount, 1);
}
