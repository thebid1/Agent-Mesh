# Agent Mesh — Autonomous AI Agent Swarm on Solana

A live multi-agent economic simulation where 4 specialized AI agents trade autonomously on a custom Solana AMM, creating emergent market behavior through inter-agent coordination.

## What It Does

Agent Mesh deploys four autonomous agents—each with distinct economic strategies—onto Solana devnet. The agents communicate via a message bus, request liquidity from a central Banker when low, and trade against a custom constant-product AMM. A Volatility Generator creates price movements, giving the agents opportunities to execute their strategies. Everything runs live on-chain with real transaction signatures.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           AGENT MESH SWARM                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌───────────────┐ ┌───────────────┐ ┌───────────────┐ ┌─────────────────┐  │
│  │  Arbitrageur  │ │    Liquidity  │ │ Trend Follower│ │     Banker      │  │
│  │     Agent     │ │    Provider   │ │     Agent     │ │     Agent       │  │
│  │  (📈 Green)   │ │   (💧 Purple) │ │  (📊 Blue)    │ │  (🏦 Orange)    │  │
│  │               │ │               │ │               │ │                 │  │
│  │ Buy dips >0.2%│ │Add liquidity  │ │MA3/MA5 cross  │ │Fund agents <0.3 │  │
│  │Sell rallies   │ │based on TVL   │ │Trend following│ │SOL, track debt  │  │
│  └───────┬───────┘ └───────┬───────┘ └───────┬───────┘ └────────┬────────┘  │
│          │                 │                 │                  │           │
│          └─────────────────┴─────────────────┘                  │           │
│                            │                                    │           │
│                   ┌────────▼────────┐                          │           │
│                   │   MessageBus    │◄─────────────────────────┘           │
│                   │  (Port 3001)    │                                      │
│                   │  HTTP polling   │                                      │
│                   └────────┬────────┘                                      │
│                            │                                               │
│          ┌─────────────────┴─────────────────┐                            │
│          │                                   │                            │
│   ┌──────▼───────┐                 ┌─────────▼──────────┐                 │
│   │ WalletManager│                 │  Volatility Gen    │                 │
│   │AES-256-GCM   │                 │  (Treasury)        │                 │
│   │encrypted keys│                 │  Creates price     │                 │
│   └──────┬───────┘                 │  action every 15s  │                 │
│          │                         └─────────┬──────────┘                 │
│          │                                   │                            │
│   ┌──────▼───────────────────────────────────▼──────────┐                 │
│   │           Custom AMM Program                        │                 │
│   │   5LU3snhGuiRYF1u1W3cX8xUYoPbNYiZHKPQgqZgxQJi6  │                 │
│   │   • 4 token pools (AUSDC, ABTC, AETH, ASOL)         │                 │
│   │   • Constant product formula (x * y = k)            │                 │
│   │   • PDA-based vaults, slippage protection           │                 │
│   └─────────────────────────────────────────────────────┘                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

All signing happens automatically within the WalletManager. Agents never handle raw private keys—they request operations through the WalletManager, which decrypts keys on-demand using the `WALLET_ENCRYPTION_KEY` environment variable.

## Agents

| Agent | Strategy | Trade Frequency | Key Behavior |
|-------|----------|-----------------|--------------|
| **Arbitrageur** | Price momentum: buys when price drops >0.2%, sells when rises >0.2% | ~5 min scans | Auto-sells after 5 consecutive buys to lock profits |
| **Trend Follower** | Moving average crossover: MA3 vs MA5 golden/death cross | ~10 sec scans | Force-trades after 5 scans if no signal; clears history post-trade |
| **Liquidity Provider** | TVL-based adds: more to low-TVL pools for higher fee share | ~1 min scans | Auto-buys tokens via swap if insufficient for liquidity add |
| **Banker** | Central liquidity provider: monitors all agents, transfers SOL when balance <0.3 | ~15 sec scans | Tracks trust scores, debt per agent; accepts repayments |

## Quick Start

### Prerequisites
- Node.js 18+
- Solana devnet SOL for treasury (automated faucet request in setup)

### 1. Install
```bash
git clone https://github.com/thebid1/Agent-Mesh.git
cd agent-mesh
npm install
cp .env.template .env
```

### 2. Generate Encryption Key
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Add to `.env` as `WALLET_ENCRYPTION_KEY`.

### 3. Create Treasury
```bash
npm run generate-treasury
```
Creates encrypted treasury wallet at `./treasury-keypair.enc.json`.

### 4. Setup Treasury Tokens
```bash
npm run setup-treasury
```
**Requires:** ~5-10 SOL in treasury (for tokens + volatility generation)

This script:
- Requests devnet SOL from faucet (or use https://faucet.solana.com)
- Buys AUSDC, ABTC, AETH, ASOL from AMM pools (~1-2 SOL worth)
- **Treasury also runs the Volatility Generator** — executes random swaps to create price movements for agents to trade against

### 5. Create Agents
```bash
npm run init-interactive
```
Interactive prompt to create 4 agent wallets with encrypted key storage.

### 6. Fund Agents
```bash
npm run fund-interactive
```
Distributes SOL from treasury to agent wallets based on agent type allocations.

### 7. Start Trading
```bash
# Terminal 1: Generate volatility
npm run volatility

# Terminal 2: Launch all agents
npm run swarm

# Terminal 3: Web dashboard
npm run dashboard
```

Open http://localhost:3456 for real-time monitoring.

## Token Faucet

AUSDC, ABTC, AETH, and ASOL are custom tokens minted on devnet for this project. They have no real value and are used solely for the agent simulation.

**To acquire tokens:**
1. Run `npm run setup-treasury` — automatically buys all 4 tokens from pools
2. Or request from the deployed pools directly via the AMM

Token mints are defined in `token-mints.json` and `src/config/index.ts`.

### Creating Your Own Tokens (Optional)

To create custom tokens with Metaplex:

```bash
# Install Metaplex CLI
npm install -g @metaplex-foundation/cli

# Create token with metadata
metaplex create token --name "Your Token" --symbol "YTK" --decimals 6 --url https://arweave.net/YOUR_METADATA_URI

# Mint supply to your wallet
metaplex mint token --token <TOKEN_MINT> --amount 1000000
```

Update `token-mints.json` and `pool-configs.json` with your new token addresses.

## Deploying Your Own AMM Program (Optional)

To deploy the custom AMM program from source:

```bash
cd anchor-amm

# Install dependencies
npm install

# Build the program
anchor build

# Deploy to devnet
anchor deploy --provider.cluster devnet

# Get program ID
solana address -k target/deploy/agent_amm-keypair.json

# Update program ID in anchor-amm/app/idl.json
# Update pool PDAs in pool-configs.json using new program
```

**Program source:** `anchor-amm/programs/amm/src/lib.rs`

Key instructions:
- `initialize_pool` — Create new token pool
- `add_liquidity` — Deposit tokens + SOL
- `swap` — Execute token swaps

## Security Model

Agent wallets use **AES-256-GCM encryption** with **PBKDF2 key derivation** (100,000 iterations, SHA-256). Private keys are never stored plaintext—they're decrypted on-demand using the `WALLET_ENCRYPTION_KEY` environment variable. The WalletManager handles all signing internally; agents request operations but never access raw key material.

## Project Structure

```
agent-mesh/
├── src/
│   ├── agents/              # Agent implementations
│   │   ├── BaseAgent.ts     # Abstract base with wallet, logging, P&L
│   │   ├── ArbitrageurAgent.ts   # Price momentum strategy
│   │   ├── TrendFollowerAgent.ts # MA crossover strategy
│   │   ├── LiquidityProviderAgent.ts # Pool liquidity adds
│   │   └── BankerAgent.ts   # Central liquidity provider
│   ├── wallet/
│   │   └── WalletManager.ts # Encrypted wallet management
│   ├── comms/
│   │   ├── MessageBus.ts    # Agent communication client
│   │   └── MessageBroker.ts # HTTP broker for cross-process comms
│   ├── utils/
│   │   ├── encryption.ts    # AES-256-GCM utilities
│   │   └── TransactionLogger.ts # Unified transaction log
│   ├── config/
│   │   ├── index.ts         # Network, token constants
│   │   └── agent-definitions.ts # Agent type defaults
│   ├── types/index.ts       # TypeScript interfaces
│   ├── index.ts             # Single agent launcher
│   └── swarm.ts             # Multi-agent launcher with colors
├── scripts/
│   ├── generate-treasury.ts # Create treasury wallet
│   ├── setup-treasury-tokens.ts # Buy tokens for treasury
│   ├── interactive-init.ts  # Create agent wallets
│   ├── interactive-fund.ts  # Fund agents from treasury
│   ├── volatilityGenerator.ts # Create price movements
│   └── check-balances.ts    # Check all wallet balances
├── dashboard/
│   ├── server.js            # Express API + static files
│   ├── index.html           # Dashboard UI
│   └── dashboard.js         # Frontend logic
├── anchor-amm/
│   ├── programs/amm/src/lib.rs  # Rust program source
│   └── app/idl.json         # Anchor IDL
├── agent-keypairs/          # Encrypted agent wallets
├── logs/
│   ├── all-transactions.json # Unified transaction log
│   └── message-bus.json     # Message persistence
├── agents.config.json       # Agent registry
├── pool-configs.json        # AMM pool addresses
├── token-mints.json         # Token metadata
└── wallet-registry.json     # Treasury + agent public keys
```

## Devnet Transactions

Recent live transactions (from `logs/all-transactions.json`):

| Time | Agent | Action | Token | TX Signature |
|------|-------|--------|-------|--------------|
| 08:41:24 | trend-follower-04 | BUY | AUSDC | [5xttzTWw...](https://explorer.solana.com/tx/5xttzTWw74YTbqnb9gtAAYpXwCkANzdHAPTYYRiMPjoBLTjKt9mkFBqdSqD72H6o9B4mfVupMttVvKd8ybZjxdQJ?cluster=devnet) |
| 08:41:26 | arbitrageur-01 | BUY | AUSDC | [2QsazZcis...](https://explorer.solana.com/tx/2QsazZcisVRYi6B94QTY9m9VETXq7oy9aVbZvLifiKEQEemR4kQJNGu37LGFib9mYUdYTtG6CRTsAweP73HVkXM?cluster=devnet) |
| 08:41:28 | arbitrageur-01 | BUY | ASOL | [4qwe343ycz...](https://explorer.solana.com/tx/4qwe343yczCvK72s3R5r28jtNEfMt1XJwrEs23dwMrpLQSiTFKRWDPfvYHLqWfMoi2gudxwC5uhVgPTDPLreRvYS?cluster=devnet) |

## Troubleshooting

### Transaction Timeouts on Devnet

Solana devnet can experience congestion, causing transactions to timeout or fail. If you encounter:

```
Error: Transaction was not confirmed in 30.00 seconds
```

**Solutions:**
1. **Check transaction status on explorer** — Copy the transaction signature (if available) and verify on [Solana Explorer](https://explorer.solana.com/?cluster=devnet). The transaction may have succeeded despite the timeout error.

2. **Retry the operation** — Devnet is eventually consistent; simply run the command again.

3. **Use a custom RPC** — Public devnet RPC can be slow. Add a custom RPC URL to `.env`:
   ```
   SOLANA_RPC_URL=https://solana-devnet.g.alchemy.com/v2/YOUR_API_KEY
   ```

4. **Increase confirmation timeout** — Modify scripts to use longer timeout values if needed.

**Best Practice:** Always verify on-chain before retrying. Check your wallet balances or pool states to confirm whether the previous transaction actually succeeded before attempting again.

## Known Limitations

1. **Devnet only** — All contracts and tokens are on Solana devnet
2. **Small pools** — ~5 SOL depth per pool; designed for demonstration, not production liquidity
3. **Custom tokens** — AUSDC/ABTC/AETH/ASOL have no real value
4. **Trade size limits** — AETH trades limited to 0.005 SOL to avoid u64 overflow in constant product math
5. **No Jupiter integration** — Uses custom AMM exclusively
6. **Devnet reliability** — Transactions may timeout due to devnet congestion; verify on-chain before retrying

These constraints are intentional design choices for a self-contained demo environment that can run indefinitely without external dependencies.

## License

MIT
