use anchor_lang::{prelude::*, AccountSerialize};
use anchor_lang::solana_program::program_pack::Pack;
use anchor_spl::{
    associated_token::{self, get_associated_token_address, AssociatedToken},
    token::{self, Burn, InitializeMint, MintTo, SetAuthority, Token},
};
use anchor_lang::solana_program::{program::{invoke, invoke_signed}, system_instruction, system_program};

declare_id!("Gvob5UYJiC2EvqFW6xgyq15EEypp3YpFy2G1La6rctnC");

pub const USER_STATE_SEED: &[u8] = b"user-state";
pub const COMPOSITION_SEED: &[u8] = b"composition";
pub const LOCK_RECORD_SEED: &[u8] = b"lock";
pub const MAX_ASSETS: usize = 8;
pub const SCENE_KEY_BYTES: usize = 32;

#[program]
pub mod stitchx_sid {
    use super::*;

    pub fn initialize_user(ctx: Context<InitializeUser>) -> Result<()> {
        // The user state PDA is the protocol's per-wallet counter. It starts at zero
        // so we can assign deterministic composition IDs in later calls.
        let user_state = &mut ctx.accounts.user_state;
        user_state.authority = ctx.accounts.authority.key();
        user_state.composition_count = 0;
        user_state.bump = ctx.bumps.user_state;
        Ok(())
    }

    pub fn lock_and_compose<'info>(ctx: Context<'info, LockAndCompose<'info>>,
        scene_key: [u8; SCENE_KEY_BYTES],
        asset_mints: Vec<Pubkey>,
    ) -> Result<()> {
        require!(
            !asset_mints.is_empty() && asset_mints.len() <= MAX_ASSETS,
            ErrorCode::InvalidAssetCount
        );

        let user_state = &mut ctx.accounts.user_state;
        let composition = &mut ctx.accounts.composition;
        let comp_id = user_state.composition_count;

        require!(
            ctx.remaining_accounts.len() == asset_mints.len() * 2,
            ErrorCode::AssetAlreadyLocked
        );

        for (asset_mint, remaining_pair) in asset_mints
            .iter()
            .zip(ctx.remaining_accounts.chunks_exact(2))
        {
            let token_account_info = &remaining_pair[0];
            let lock_record_info = &remaining_pair[1];

            let token_account_data = token_account_info.try_borrow_data()?;
            let token_account =
                anchor_spl::token::spl_token::state::Account::unpack(&token_account_data)?;
            require!(
                token_account.owner == ctx.accounts.authority.key()
                    && token_account.mint == *asset_mint
                    && token_account.amount >= 1,
                ErrorCode::InvalidState
            );

            let (lock_record_key, lock_bump) = Pubkey::find_program_address(
                &[LOCK_RECORD_SEED, asset_mint.as_ref()],
                ctx.program_id,
            );
            require!(
                lock_record_info.key() == lock_record_key,
                ErrorCode::AssetAlreadyLocked
            );
            require!(
                lock_record_info.owner == &system_program::ID && lock_record_info.lamports() == 0,
                ErrorCode::InvalidState
            );

            let create_lock_record_ix = system_instruction::create_account(
                &ctx.accounts.authority.key(),
                &lock_record_key,
                Rent::get()?.minimum_balance(LockRecord::LEN),
                LockRecord::LEN as u64,
                ctx.program_id,
            );
            let authority_info = ctx.accounts.authority.to_account_info();
            let lock_record_info = lock_record_info.clone();
            invoke_signed(
                &create_lock_record_ix,
                &[authority_info, lock_record_info.clone()],
                &[&[LOCK_RECORD_SEED, asset_mint.as_ref(), &[lock_bump]]],
            )?;

            let lock_record = LockRecord {
                asset_mint: *asset_mint,
                composition: composition.key(),
                owner: ctx.accounts.authority.key(),
            };
            let mut data = lock_record_info.try_borrow_mut_data()?;
            let mut writer = std::io::Cursor::new(&mut data[..]);
            lock_record.try_serialize(&mut writer)?;
        }

        composition.owner = ctx.accounts.authority.key();
        composition.comp_id = comp_id;
        composition.asset_count = asset_mints.len() as u8;
        composition.asset_mints = pack_asset_mints(&asset_mints);
        composition.scene_key = scene_key;
        composition.status = CompositionStatus::Locked;
        composition.composition_mint = Pubkey::default();
        composition.version = 1;
        composition.bump = ctx.bumps.composition;

        // We increment after using the current count so the PDA seed and stored ID match.
        user_state.composition_count = user_state
            .composition_count
            .checked_add(1)
            .ok_or(ErrorCode::CompositionCountOverflow)?;

        Ok(())
    }

    pub fn mint_composition(ctx: Context<MintComposition>) -> Result<()> {
        require!(
            ctx.accounts.composition.status == CompositionStatus::Locked,
            ErrorCode::CompositionAlreadyMinted
        );

        // Create the mint account explicitly so this works on Anchor 1.0.2 without newer init helpers.
        let mint_rent = Rent::get()?.minimum_balance(anchor_spl::token::spl_token::state::Mint::LEN);
        let create_mint_ix = system_instruction::create_account(
            &ctx.accounts.owner.key(),
            &ctx.accounts.composition_mint.key(),
            mint_rent,
            anchor_spl::token::spl_token::state::Mint::LEN as u64,
            &token::ID,
        );
        invoke(
            &create_mint_ix,
            &[
                ctx.accounts.owner.to_account_info(),
                ctx.accounts.composition_mint.to_account_info(),
            ],
        )?;

        let init_mint_ctx = CpiContext::new(
            ctx.accounts.token_program.key(),
            InitializeMint {
                mint: ctx.accounts.composition_mint.to_account_info(),
                rent: ctx.accounts.rent.to_account_info(),
            },
        );
        token::initialize_mint(
            init_mint_ctx,
            0,
            &ctx.accounts.owner.key(),
            Some(&ctx.accounts.owner.key()),
        )?;

        let create_ata_ctx = CpiContext::new(
            ctx.accounts.associated_token_program.key(),
            associated_token::Create {
                payer: ctx.accounts.owner.to_account_info(),
                associated_token: ctx.accounts.owner_ata.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
                mint: ctx.accounts.composition_mint.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
        );
        associated_token::create(create_ata_ctx)?;

        // Mint exactly one token with zero decimals so the composition NFT behaves like a 1/1.
        let mint_to_ctx = CpiContext::new(
            ctx.accounts.token_program.key(),
            MintTo {
                mint: ctx.accounts.composition_mint.to_account_info(),
                to: ctx.accounts.owner_ata.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        );
        token::mint_to(mint_to_ctx, 1)?;

        // Removing mint authority prevents any future supply inflation.
        let revoke_mint_authority_ctx = CpiContext::new(
            ctx.accounts.token_program.key(),
            SetAuthority {
                account_or_mint: ctx.accounts.composition_mint.to_account_info(),
                current_authority: ctx.accounts.owner.to_account_info(),
            },
        );
        token::set_authority(
            revoke_mint_authority_ctx,
            anchor_spl::token::spl_token::instruction::AuthorityType::MintTokens,
            None,
        )?;

        // Freeze authority is optional for the MVP, but revoking it keeps the NFT fully
        // permissionless after creation and matches the "authority removed" intent.
        let revoke_freeze_authority_ctx = CpiContext::new(
            ctx.accounts.token_program.key(),
            SetAuthority {
                account_or_mint: ctx.accounts.composition_mint.to_account_info(),
                current_authority: ctx.accounts.owner.to_account_info(),
            },
        );
        token::set_authority(
            revoke_freeze_authority_ctx,
            anchor_spl::token::spl_token::instruction::AuthorityType::FreezeAccount,
            None,
        )?;

        let composition = &mut ctx.accounts.composition;
        composition.composition_mint = ctx.accounts.composition_mint.key();
        composition.status = CompositionStatus::Minted;

        Ok(())
    }

    pub fn burn_and_unlock<'info>(
        ctx: Context<'info, BurnAndUnlock<'info>>,
    ) -> Result<()> {
        require!(
            ctx.accounts.composition.status == CompositionStatus::Minted,
            ErrorCode::InvalidState
        );
        require!(
            ctx.accounts.composition.composition_mint != Pubkey::default(),
            ErrorCode::InvalidState
        );
        require_keys_eq!(
            ctx.accounts.composition_mint.key(),
            ctx.accounts.composition.composition_mint,
            ErrorCode::InvalidOwner
        );
        require_keys_eq!(
            get_associated_token_address(&ctx.accounts.owner.key(), &ctx.accounts.composition_mint.key()),
            ctx.accounts.owner_ata.key(),
            ErrorCode::InvalidOwner
        );

        let composition_mint = ctx.accounts.composition.composition_mint;
        let owner_info = ctx.accounts.owner.to_account_info();
        let owner_ata_info = ctx.accounts.owner_ata.to_account_info();
        let owner_ata_data = owner_ata_info.try_borrow_data()?;
        let token_account = anchor_spl::token::spl_token::state::Account::unpack(&owner_ata_data)?;
        require!(
            token_account.owner == ctx.accounts.owner.key()
                && token_account.mint == composition_mint
                && token_account.amount == 1,
            ErrorCode::InvalidOwner
        );
        drop(owner_ata_data);

        require!(
            ctx.remaining_accounts.len() == ctx.accounts.composition.asset_count as usize,
            ErrorCode::InvalidState
        );

        let burn_ctx = CpiContext::new(
            ctx.accounts.token_program.key(),
            Burn {
                mint: ctx.accounts.composition_mint.to_account_info(),
                from: owner_ata_info.clone(),
                authority: owner_info.clone(),
            },
        );
        token::burn(burn_ctx, 1)?;

        for (asset_mint, lock_record_info) in ctx
            .accounts
            .composition
            .asset_mints
            .iter()
            .take(ctx.accounts.composition.asset_count as usize)
            .zip(ctx.remaining_accounts.iter())
        {
            let (lock_key, _) = Pubkey::find_program_address(
                &[LOCK_RECORD_SEED, asset_mint.as_ref()],
                ctx.program_id,
            );
            require_keys_eq!(lock_record_info.key(), lock_key, ErrorCode::InvalidState);
            require!(lock_record_info.owner == ctx.program_id, ErrorCode::InvalidState);

            let lock_record_data = lock_record_info.try_borrow_data()?;
            let mut lock_record_slice: &[u8] = &lock_record_data;
            let lock_record = LockRecord::try_deserialize(&mut lock_record_slice)?;
            require_keys_eq!(lock_record.asset_mint, *asset_mint, ErrorCode::InvalidState);
            require_keys_eq!(
                lock_record.composition,
                ctx.accounts.composition.key(),
                ErrorCode::InvalidState
            );
            require_keys_eq!(lock_record.owner, ctx.accounts.owner.key(), ErrorCode::InvalidState);
            drop(lock_record_data);

            close_program_account(lock_record_info, &owner_info)?;
        }

        ctx.accounts.composition.status = CompositionStatus::Unlocked;

        Ok(())
    }

    pub fn update_composition<'info>(
        ctx: Context<'info, UpdateComposition<'info>>,
        scene_key: [u8; SCENE_KEY_BYTES],
        asset_mints: Vec<Pubkey>,
    ) -> Result<()> {
        require!(
            ctx.accounts.composition.owner == ctx.accounts.owner.key(),
            ErrorCode::InvalidOwner
        );
        require!(
            ctx.accounts.composition.status != CompositionStatus::Unlocked,
            ErrorCode::InvalidState
        );
        require!(
            !asset_mints.is_empty() && asset_mints.len() <= MAX_ASSETS,
            ErrorCode::InvalidAssetCount
        );

        let old_asset_count = ctx.accounts.composition.asset_count as usize;
        let new_asset_count = asset_mints.len();
        require!(
            ctx.remaining_accounts.len() == old_asset_count + (new_asset_count * 2),
            ErrorCode::InvalidState
        );

        let owner_info = ctx.accounts.owner.to_account_info();
        let composition_key = ctx.accounts.composition.key();

        // Close the old lock records first so the previous asset set is released before
        // we establish the new composition state.
        for (asset_mint, lock_record_info) in ctx
            .accounts
            .composition
            .asset_mints
            .iter()
            .take(old_asset_count)
            .zip(ctx.remaining_accounts.iter().take(old_asset_count))
        {
            let (lock_key, _) = Pubkey::find_program_address(
                &[LOCK_RECORD_SEED, asset_mint.as_ref()],
                ctx.program_id,
            );
            require_keys_eq!(lock_record_info.key(), lock_key, ErrorCode::InvalidState);
            require!(lock_record_info.owner == ctx.program_id, ErrorCode::InvalidState);

            let lock_record_data = lock_record_info.try_borrow_data()?;
            let mut lock_record_slice: &[u8] = &lock_record_data;
            let lock_record = LockRecord::try_deserialize(&mut lock_record_slice)?;
            require_keys_eq!(lock_record.asset_mint, *asset_mint, ErrorCode::InvalidState);
            require_keys_eq!(
                lock_record.composition,
                composition_key,
                ErrorCode::InvalidState
            );
            require_keys_eq!(lock_record.owner, ctx.accounts.owner.key(), ErrorCode::InvalidState);
            drop(lock_record_data);

            close_program_account(lock_record_info, &owner_info)?;
        }

        let new_lock_accounts = &ctx.remaining_accounts[old_asset_count..];
        for (asset_mint, remaining_pair) in asset_mints.iter().zip(new_lock_accounts.chunks_exact(2)) {
            let token_account_info = &remaining_pair[0];
            let lock_record_info = &remaining_pair[1];

            let token_account_data = token_account_info.try_borrow_data()?;
            let token_account =
                anchor_spl::token::spl_token::state::Account::unpack(&token_account_data)?;
            require!(
                token_account.owner == ctx.accounts.owner.key()
                    && token_account.mint == *asset_mint
                    && token_account.amount >= 1,
                ErrorCode::InvalidState
            );

            let (lock_record_key, lock_bump) = Pubkey::find_program_address(
                &[LOCK_RECORD_SEED, asset_mint.as_ref()],
                ctx.program_id,
            );
            require!(
                lock_record_info.key() == lock_record_key,
                ErrorCode::AssetAlreadyLocked
            );
            require!(
                lock_record_info.owner == &system_program::ID && lock_record_info.lamports() == 0,
                ErrorCode::InvalidState
            );

            let create_lock_record_ix = system_instruction::create_account(
                &ctx.accounts.owner.key(),
                &lock_record_key,
                Rent::get()?.minimum_balance(LockRecord::LEN),
                LockRecord::LEN as u64,
                ctx.program_id,
            );
            let lock_record_info = lock_record_info.clone();
            invoke_signed(
                &create_lock_record_ix,
                &[owner_info.clone(), lock_record_info.clone()],
                &[&[LOCK_RECORD_SEED, asset_mint.as_ref(), &[lock_bump]]],
            )?;

            let lock_record = LockRecord {
                asset_mint: *asset_mint,
                composition: composition_key,
                owner: ctx.accounts.owner.key(),
            };
            let mut data = lock_record_info.try_borrow_mut_data()?;
            let mut writer = std::io::Cursor::new(&mut data[..]);
            lock_record.try_serialize(&mut writer)?;
        }

        let composition = &mut ctx.accounts.composition;
        composition.asset_count = asset_mints.len() as u8;
        composition.asset_mints = pack_asset_mints(&asset_mints);
        composition.scene_key = scene_key;
        composition.version = composition
            .version
            .checked_add(1)
            .ok_or(ErrorCode::InvalidState)?;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeUser<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// PDA that tracks how many compositions this wallet has created.
    #[account(
        init,
        payer = authority,
        space = UserState::LEN,
        seeds = [USER_STATE_SEED, authority.key().as_ref()],
        bump
    )]
    pub user_state: Account<'info, UserState>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct LockAndCompose<'info> {
    #[account(
        mut,
        seeds = [USER_STATE_SEED, authority.key().as_ref()],
        bump = user_state.bump,
        has_one = authority
    )]
    pub user_state: Account<'info, UserState>,

    #[account(
        init,
        payer = authority,
        space = Composition::LEN,
        seeds = [
            COMPOSITION_SEED,
            authority.key().as_ref(),
            &user_state.composition_count.to_le_bytes()
        ],
        bump
    )]
    pub composition: Account<'info, Composition>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MintComposition<'info> {
    #[account(
        mut,
        has_one = owner,
        seeds = [
            COMPOSITION_SEED,
            owner.key().as_ref(),
            &composition.comp_id.to_le_bytes()
        ],
        bump = composition.bump
    )]
    pub composition: Account<'info, Composition>,

    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(mut)]
    pub composition_mint: Signer<'info>,

    #[account(mut)]
    /// CHECK: This is the ATA address we create during the instruction. The associated token CPI
    /// validates that the address matches the derived ATA for `owner` and `composition_mint`.
    pub owner_ata: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct BurnAndUnlock<'info> {
    #[account(
        mut,
        has_one = owner,
        seeds = [
            COMPOSITION_SEED,
            owner.key().as_ref(),
            &composition.comp_id.to_le_bytes()
        ],
        bump = composition.bump
    )]
    pub composition: Account<'info, Composition>,

    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(mut)]
    /// CHECK: The mint is validated against the composition and ATA data before burn.
    pub composition_mint: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: The ATA is validated by unpacking the SPL token account before burn.
    pub owner_ata: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct UpdateComposition<'info> {
    #[account(
        mut,
        has_one = owner,
        seeds = [
            COMPOSITION_SEED,
            owner.key().as_ref(),
            &composition.comp_id.to_le_bytes()
        ],
        bump = composition.bump
    )]
    pub composition: Account<'info, Composition>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[account]
pub struct UserState {
    pub authority: Pubkey,
    pub composition_count: u64,
    pub bump: u8,
}

impl UserState {
    // Anchor account space must include the 8-byte discriminator.
    pub const LEN: usize = 8 + 32 + 8 + 1;
}

#[account]
pub struct Composition {
    pub owner: Pubkey,
    pub comp_id: u64,
    pub asset_count: u8,
    pub asset_mints: [Pubkey; MAX_ASSETS],
    pub scene_key: [u8; SCENE_KEY_BYTES],
    pub status: CompositionStatus,
    pub composition_mint: Pubkey,
    pub bump: u8,
    pub version: u64,
}

impl Composition {
    // Fixed-size layout keeps this first MVP simple and easy to reason about.
    pub const LEN: usize = 8 + 32 + 8 + 1 + (32 * MAX_ASSETS) + SCENE_KEY_BYTES + 1 + 32 + 1 + 8;
}

#[account]
pub struct LockRecord {
    pub asset_mint: Pubkey,
    pub composition: Pubkey,
    pub owner: Pubkey,
}

impl LockRecord {
    pub const LEN: usize = 8 + 32 + 32 + 32;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompositionStatus {
    Locked,
    Minted,
    Unlocked,
}

#[error_code]
pub enum ErrorCode {
    #[msg("The composition must contain between 1 and 8 asset mints.")]
    InvalidAssetCount,
    #[msg("The composition NFT has already been minted.")]
    CompositionAlreadyMinted,
    #[msg("The user has exceeded the maximum composition count.")]
    CompositionCountOverflow,
    #[msg("This asset is already locked into another composition.")]
    AssetAlreadyLocked,
    #[msg("The composition is not in a valid state for this operation.")]
    InvalidState,
    #[msg("The caller does not own the composition NFT.")]
    InvalidOwner,
}

fn pack_asset_mints(asset_mints: &[Pubkey]) -> [Pubkey; MAX_ASSETS] {
    let mut packed = [Pubkey::default(); MAX_ASSETS];
    for (index, mint) in asset_mints.iter().enumerate() {
        packed[index] = *mint;
    }
    packed
}

fn close_program_account(account: &AccountInfo, destination: &AccountInfo) -> Result<()> {
    **destination.try_borrow_mut_lamports()? = destination
        .lamports()
        .checked_add(account.lamports())
        .ok_or(ErrorCode::InvalidState)?;
    **account.try_borrow_mut_lamports()? = 0;
    account.assign(&system_program::ID);
    account.resize(0)?;
    Ok(())
}
