use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("5LU3snhGuiRYF1u1W3cX8xUYoPbNYiZHKPQgqZgxQJi6");

#[program]
pub mod simple_swap {
    use super::*;

    pub fn initialize_pool(ctx: Context<InitializePool>) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        pool.authority = ctx.accounts.authority.key();
        pool.mint_a = ctx.accounts.mint_a.key();
        pool.mint_b = ctx.accounts.mint_b.key();
        pool.bump = ctx.bumps.pool;
        Ok(())
    }

    pub fn add_liquidity(ctx: Context<AddLiquidity>, amount_a: u64, amount_b: u64) -> Result<()> {
        // Transfer tokens from user to pool vaults
        let cpi_accounts_a = Transfer {
            from: ctx.accounts.user_token_a.to_account_info(),
            to: ctx.accounts.vault_a.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx_a = CpiContext::new(cpi_program.clone(), cpi_accounts_a);
        token::transfer(cpi_ctx_a, amount_a)?;

        let cpi_accounts_b = Transfer {
            from: ctx.accounts.user_token_b.to_account_info(),
            to: ctx.accounts.vault_b.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_ctx_b = CpiContext::new(cpi_program, cpi_accounts_b);
        token::transfer(cpi_ctx_b, amount_b)?;

        Ok(())
    }

    pub fn swap(
        ctx: Context<Swap>,
        amount_in: u64,
        minimum_amount_out: u64,
        a_to_b: bool, // true if swapping A for B, false if swapping B for A
    ) -> Result<()> {
        // Get current balances
        let balance_a = ctx.accounts.vault_a.amount;
        let balance_b = ctx.accounts.vault_b.amount;

        // Calculate output amount using constant product formula (x * y = k)
        let amount_out = if a_to_b {
            calculate_swap_output(amount_in, balance_a, balance_b)?
        } else {
            calculate_swap_output(amount_in, balance_b, balance_a)?
        };

        require!(amount_out >= minimum_amount_out, SwapError::SlippageTooHigh);

        // Perform the swap
        if a_to_b {
            // Transfer token A from user to vault
            let cpi_accounts_in = Transfer {
                from: ctx.accounts.user_token_a.to_account_info(),
                to: ctx.accounts.vault_a.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            };
            let cpi_ctx_in = CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts_in,
            );
            token::transfer(cpi_ctx_in, amount_in)?;

            // Transfer token B from vault to user
            let seeds = &[
                b"pool",
                ctx.accounts.pool.mint_a.as_ref(),
                ctx.accounts.pool.mint_b.as_ref(),
                &[ctx.accounts.pool.bump],
            ];
            let signer = &[&seeds[..]];

            let cpi_accounts_out = Transfer {
                from: ctx.accounts.vault_b.to_account_info(),
                to: ctx.accounts.user_token_b.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            };
            let cpi_ctx_out = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts_out,
                signer,
            );
            token::transfer(cpi_ctx_out, amount_out)?;
        } else {
            // Transfer token B from user to vault
            let cpi_accounts_in = Transfer {
                from: ctx.accounts.user_token_b.to_account_info(),
                to: ctx.accounts.vault_b.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            };
            let cpi_ctx_in = CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts_in,
            );
            token::transfer(cpi_ctx_in, amount_in)?;

            // Transfer token A from vault to user
            let seeds = &[
                b"pool",
                ctx.accounts.pool.mint_a.as_ref(),
                ctx.accounts.pool.mint_b.as_ref(),
                &[ctx.accounts.pool.bump],
            ];
            let signer = &[&seeds[..]];

            let cpi_accounts_out = Transfer {
                from: ctx.accounts.vault_a.to_account_info(),
                to: ctx.accounts.user_token_a.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            };
            let cpi_ctx_out = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts_out,
                signer,
            );
            token::transfer(cpi_ctx_out, amount_out)?;
        }

        Ok(())
    }
}

// Helper function to calculate swap output using constant product formula
fn calculate_swap_output(amount_in: u64, reserve_in: u64, reserve_out: u64) -> Result<u64> {
    let numerator = amount_in
        .checked_mul(reserve_out)
        .ok_or(SwapError::MathOverflow)?;

    let denominator = reserve_in
        .checked_add(amount_in)
        .ok_or(SwapError::MathOverflow)?;

    let amount_out = numerator
        .checked_div(denominator)
        .ok_or(SwapError::MathOverflow)?;

    Ok(amount_out)
}

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + Pool::INIT_SPACE,
        seeds = [b"pool", mint_a.key().as_ref(), mint_b.key().as_ref()],
        bump
    )]
    pub pool: Account<'info, Pool>,

    pub mint_a: Account<'info, Mint>,
    pub mint_b: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        token::mint = mint_a,
        token::authority = pool,
        seeds = [b"vault_a", pool.key().as_ref()],
        bump
    )]
    pub vault_a: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = authority,
        token::mint = mint_b,
        token::authority = pool,
        seeds = [b"vault_b", pool.key().as_ref()],
        bump
    )]
    pub vault_b: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AddLiquidity<'info> {
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool", pool.mint_a.as_ref(), pool.mint_b.as_ref()],
        bump = pool.bump
    )]
    pub pool: Account<'info, Pool>,

    #[account(mut)]
    pub user_token_a: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user_token_b: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"vault_a", pool.key().as_ref()],
        bump,
        token::mint = pool.mint_a,
        token::authority = pool,
    )]
    pub vault_a: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"vault_b", pool.key().as_ref()],
        bump,
        token::mint = pool.mint_b,
        token::authority = pool,
    )]
    pub vault_b: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool", pool.mint_a.as_ref(), pool.mint_b.as_ref()],
        bump = pool.bump
    )]
    pub pool: Account<'info, Pool>,

    #[account(mut)]
    pub user_token_a: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user_token_b: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"vault_a", pool.key().as_ref()],
        bump,
        token::mint = pool.mint_a,
        token::authority = pool,
    )]
    pub vault_a: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"vault_b", pool.key().as_ref()],
        bump,
        token::mint = pool.mint_b,
        token::authority = pool,
    )]
    pub vault_b: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub authority: Pubkey,
    pub mint_a: Pubkey,
    pub mint_b: Pubkey,
    pub bump: u8,
}

#[error_code]
pub enum SwapError {
    #[msg("Math operation overflow")]
    MathOverflow,
    #[msg("Slippage tolerance exceeded")]
    SlippageTooHigh,
}
