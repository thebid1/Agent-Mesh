# Agent Mesh AMM

Anchor-based Constant Product AMM for Agent Mesh trading on Solana Devnet.

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Pool PDA  │────▶│   Vault A   │────▶│  Token A    │
│  (metadata) │     │  (PDA ATA)  │     │  (AGENTUSDC)│
└─────────────┘     └─────────────┘     └─────────────┘
       │
       ▼
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Vault B   │────▶│   Token B   │────▶│     SOL     │
│  (PDA ATA)  │     │    (wSOL)   │     │             │
└─────────────┘     └─────────────┘     └─────────────┘
```

## Features

- ✅ **Initialize Pool**: Create pool for any token pair (Token/SOL)
- ✅ **Add Liquidity**: Deposit tokens into pool vaults
- ✅ **Swap**: Exchange tokens using x * y = k formula
- ✅ **Slippage Protection**: Minimum output amount enforced
- ✅ **PDA Vaults**: Secure token storage with program-derived addresses

## Prerequisites

- Rust 1.70+
- Solana CLI 1.18+
- Anchor CLI 0.30+
- Node.js 18+

## Quick Start

### 1. Deploy the Program

```bash
cd anchor-amm

# Install dependencies
yarn install

# Build the program
anchor build

# Get the program ID
anchor keys list
# Copy the output and update:
# - Anchor.toml (both localnet and devnet sections)
# - programs/amm/src/lib.rs (declare_id!)
# - app/idl.json (address field)

# Update program ID in all files
# Then rebuild
anchor build

# Deploy to devnet
anchor deploy --provider.cluster devnet
```

### 2. Create a Pool

```bash
cd app

# Install dependencies
npm install @coral-xyz/anchor @solana/web3.js @solana/spl-token

# Create AGENTUSDC/SOL pool
npx ts-node createPool.ts AGENTUSDC

# Create other pools
npx ts-node createPool.ts AGENTBTC
npx ts-node createPool.ts AGENTETH
npx ts-node createPool.ts AGENTSOL
```

### 3. Execute Swaps

```bash
# Swap SOL -> AGENTUSDC (B_TO_A = SOL is mint B)
npx ts-node swap.ts AGENTUSDC B_TO_A 0.01

# Swap AGENTUSDC -> SOL (A_TO_B = Token is mint A)
npx ts-node swap.ts AGENTUSDC A_TO_B 100
```

## Program Instructions

### Initialize Pool

Creates a new pool with PDA-based vaults for token pair.

```rust
initialize_pool(ctx: Context<InitializePool>)
```

Accounts:
- `authority`: Pool creator (signer, pays for rent)
- `pool`: Pool PDA (seeds: `["pool", mint_a, mint_b]`)
- `mint_a`: First token mint (e.g., AGENTUSDC)
- `mint_b`: Second token mint (always NATIVE_MINT for SOL)
- `vault_a`: Vault PDA for token A (seeds: `["vault_a", pool]`)
- `vault_b`: Vault PDA for token B (seeds: `["vault_b", pool]`)

### Add Liquidity

Deposits tokens into pool vaults.

```rust
add_liquidity(
    ctx: Context<AddLiquidity>,
    amount_a: u64,
    amount_b: u64,
)
```

### Swap

Executes token swap using constant product formula.

```rust
swap(
    ctx: Context<Swap>,
    amount_in: u64,
    minimum_amount_out: u64,
    a_to_b: bool,  // true = A->B (Token->SOL), false = B->A (SOL->Token)
)
```

**Formula**: `amount_out = (amount_in * reserve_out) / (reserve_in + amount_in)`

## Pool Configuration

After creating pools, `pool-configs.json` is updated:

```json
{
  "AGENTUSDC": {
    "tokenSymbol": "AGENTUSDC",
    "poolId": "...",
    "vaultA": "...",
    "vaultB": "...",
    "mintA": "3PB7QgKc5iUb8sgCpyzkTxUxKAfvcLPhMtqRuKZ64puN",
    "mintB": "So11111111111111111111111111111111111111112",
    "decimalsA": 6,
    "decimalsB": 9
  }
}
```

## Token Pairs

| Token | Mint | Decimals | Initial Liquidity |
|-------|------|----------|-------------------|
| AGENTUSDC | 3PB7QgKc5iUb8sgCpyzkTxUxKAfvcLPhMtqRuKZ64puN | 6 | 100,000 |
| AGENTBTC | 2FNb28koXRYT3SPgG3GgCoFsH1qfYdpwx5qXo9q9pH1Q | 8 | 1,000 |
| AGENTETH | Cvn7fQLsjCbdBXUiQecxDvonZfiCShgNZvCcuuAraPV1 | 8 | 5,000 |
| AGENTSOL | HyE12sVYwimSFMUQnc4AKp3TkPFKjumUhLNs4YwzngsZ | 9 | 50 |

All pools paired with SOL (5 SOL initial).

## Security

- PDA vaults with derived authorities
- Slippage protection on all swaps
- Zero-amount checks
- Empty pool protection
- Proper signer validation

## Troubleshooting

**"Program not deployed"**: Update PROGRAM_ID in createPool.ts and swap.ts

**"Insufficient funds"**: Run `solana airdrop 1 <address> --url devnet`

**"Account not found"**: Pool doesn't exist, run createPool.ts first

**"Slippage exceeded"**: Increase slippage tolerance or check pool liquidity
