# Deep Dive: Agentic Wallets on Solana

## The Problem

AI agents need wallets, but an agent wallet is fundamentally different from a user wallet. A human wallet assumes a person is present to approve transactions, review prompts, and recover from mistakes. An agent wallet must operate autonomously: it needs to sign transactions without human intervention, operate within programmatic constraints, and recover from error states without manual intervention.

Traditional custody solutions don't fit. Hardware wallets require physical button presses. Multi-sig assumes multiple humans. MPC is promising but adds network complexity. For a prototype demonstrating autonomous economic agents, we needed something simpler: programmatic control with reasonable security guarantees.

## Wallet Architecture

Agent Mesh uses a layered approach separating wallet infrastructure from agent logic.

```
[Treasury Creation]
       │
       ▼
[Encrypted Keypair Files] ──AES-256-GCM──► [WalletManager]
       │                                          │
       │                                          ▼
       │                              [Agent A] ←┘└─► [Agent B]
       │                              Arbitrageur      Trend Follower
       │
       └──────────────────► [Solana RPC] ──► [Custom AMM]
```

### Encryption Design

Keys are encrypted using **AES-256-GCM** with **PBKDF2 key derivation** (100,000 iterations, SHA-256). The 32-byte encryption key is passed via environment variable (`WALLET_ENCRYPTION_KEY`). Private keys are never stored in plaintext—they're decrypted on-demand when signing is required, then immediately discarded from memory (garbage collection permitting).

Why this approach:
- **Plaintext files**: Unacceptable for any production use
- **Hardware wallets**: Require human interaction, incompatible with automation
- **MPC**: Significant complexity, network assumptions
- **Our approach**: Good enough for devnet demonstration, straightforward key recovery via backup of the encryption key

### Separation of Concerns

The `WalletManager` class (`src/wallet/WalletManager.ts`) handles all key operations. Agents call high-level methods like `transfer(agentId, recipient, amount)`—they never see private keys. This enforces a clean boundary: agents implement strategy, WalletManager handles custody.

## Agent Design

### Why Four Agent Types?

Economic systems require diverse participants. A single arbitrageur is just a trading bot. Four agents with distinct roles create emergent behavior:

| Agent | Economic Role | Incentive |
|-------|--------------|-----------|
| **Arbitrageur** | Price discovery | Capture mean reversion |
| **Trend Follower** | Momentum trading | Ride sustained moves |
| **Liquidity Provider** | Market maker | Earn fees from spread |
| **Banker** | Central bank | Keep system solvent |

The Banker is the innovation that makes the system self-sustaining. When agents run low on SOL (needed for transaction fees), they can sell their token holdings—if that fails, they request funds from the Banker. The Banker tracks debt and credit scores. Profitable agents automatically repay from trading profits, increasing their trust score for future loans.

### Trust and Credit

The Banker maintains internal accounting:

```typescript
interface AgentCredit {
  agentId: string;
  totalRequested: number;
  totalReceived: number;
  totalRepaid: number;
  currentDebt: number;
  trustScore: number; // 0-100
}
```

New agents start with a neutral score of 50. Repayments increase trust (+5 per repayment), making future funding requests more likely to be approved. High debt (>1 SOL) or low trust (<20) results in rejected requests. This creates a rudimentary credit market within the swarm.

### Asymmetric Information

Each agent subscribes to different message types via the MessageBus:

- **Arbitrageur**: Listens for `FUND_OFFER`, `FUNDS_SENT`, `FUND_REJECTED`
- **Trend Follower**: Additionally subscribes to `OPPORTUNITY`, `TRADE_EXECUTED` for market context
- **Liquidity Provider**: Watches `TRADE_EXECUTED`, `LIQUIDITY_REQUEST` to detect high-activity pools
- **Banker**: Subscribes to `FUND_REQUEST`, `FUNDS_REPAYMENT`

This creates information asymmetry—agents have different market views based on their subscriptions, leading to divergent decisions even with the same raw data.

## Inter-Agent Communication

### Why HTTP over EventEmitter?

Agents run in separate processes (launched via `npm run swarm`). Node's EventEmitter is process-local. For cross-process communication, we needed either:

1. **Shared memory / Redis**: Added external dependency
2. **Unix sockets**: Platform-specific
3. **HTTP polling**: Universal, debuggable, works everywhere

We chose HTTP polling. The MessageBroker (`src/comms/MessageBroker.ts`) runs on port 3001, providing REST endpoints for publishing and receiving messages. Agents poll every 2 seconds for messages addressed to them.

### Message Flow

```
Agent A ──POST /publish──► MessageBroker ──GET /messages/:id──► Agent B
   │                            │
   └────────────────────────────┘ (persistence: logs/message-bus.json)
```

Messages include TTL (time-to-live) and delivery tracking. Once all 4 agents have received a broadcast, it can be cleaned up. This prevents memory bloat during long-running sessions.

### Emergent Coordination

The `TRADE_EXECUTED` message type enables emergent behavior:

1. Arbitrageur buys AUSDC, broadcasts `TRADE_EXECUTED`
2. Liquidity Provider sees high activity in AUSDC, prioritizes adding liquidity there
3. Trend Follower notes the move, may confirm with its MA analysis
4. Result: Agents "coordinate" without explicit agreement

Similarly, when the Banker sends funds, it broadcasts `FUNDS_SENT`—allowing other agents to update their view of who has liquidity.

## The Custom AMM

**Program ID:** `5LU3snhGuiRYF1u1W3cX8xUYoPbNYiZHKPQgqZgxQJi6`

### Why Build Instead of Using Jupiter?

Popular DEXs like Jupiter, Raydium, and Orca present a challenge for agent-based demos: they don't offer stable API support for devnet, and their mainnet deployments require real capital. Relying on external APIs also introduces failure modes outside our control—rate limits, deprecated endpoints, or devnet downtime.

Rather than building against unstable external APIs or resorting to mock data, we deployed a custom constant-product AMM. This gives us:
- **Deterministic behavior**: Pools behave exactly as we specify
- **No external dependencies**: The demo runs indefinitely regardless of Jupiter/Raydium's devnet status
- **Educational value**: Demonstrates understanding of AMM mechanics beyond API integration
- **Real transactions**: Every swap is a live on-chain transaction with a verifiable signature

### PDA-Based Vault Architecture

```rust
// Pool PDA: seeds = [b"pool", mint_a, mint_b]
// Vault A PDA: seeds = [b"vault_a", pool]
// Vault B PDA: seeds = [b"vault_b", pool]
```

All vaults are Program Derived Addresses, meaning the program itself controls token custody. The constant product formula (`x * y = k`) ensures prices adjust automatically based on supply and demand.

### Swap Implementation

```rust
fn calculate_swap_output(amount_in: u64, reserve_in: u64, reserve_out: u64) -> Result<u64> {
    let numerator = amount_in.checked_mul(reserve_out).ok_or(MathOverflow)?;
    let denominator = reserve_in.checked_add(amount_in).ok_or(MathOverflow)?;
    let amount_out = numerator.checked_div(denominator).ok_or(MathOverflow)?;
    Ok(amount_out)
}
```

Simple, auditable, and safe against overflow with u64 math. The program includes slippage protection—if the calculated output is less than `minimum_amount_out`, the transaction reverts.

### Trade Size Constraints

Due to u64 limits in the constant product formula, large trades can overflow. We solved this by calibrating per-pool trade sizes:

| Pool | Max Trade | Reason |
|------|-----------|--------|
| AUSDC | 0.02 SOL | High reserves (294k) |
| ABTC | 0.05 SOL | Medium price |
| AETH | 0.005 SOL | High price (1,793) |
| ASOL | 0.02 SOL | Low price |

These constraints ensure trades execute reliably while still demonstrating meaningful strategy behavior.

## Security Considerations

### Threat Model

| Threat | Mitigation |
|--------|-----------|
| Key theft from disk | Encryption at rest (AES-256-GCM) |
| Key extraction from memory | Short-lived decryption, no caching |
| Transaction manipulation | Agents sign what they construct; no external signing service |
| Runaway agent | Daily trade limits, balance checks, Banker credit limits |
| RPC failure | Configurable RPC URL, graceful degradation |

### What Production Would Do Differently

1. **HSM integration**: Store keys in hardware security modules
2. **MPC wallets**: Distributed key shares across multiple parties
3. **Transaction policies**: Spending limits per time period, whitelist/blacklist addresses
4. **Circuit breakers**: Pause all agents if aggregate losses exceed threshold
5. **Audit logging**: Immutable log of all decisions, not just transactions

The current implementation is appropriate for devnet demonstration—not for mainnet without significant hardening.

## Scalability

### Dynamic Agent Creation

The `agents.config.json` file enables adding agents without code changes:

```json
{
  "agents": [
    {
      "id": "arbitrageur-02",
      "type": "ARBITRAGEUR",
      "keypairFile": "arbitrageur-02",
      "label": "Arbitrageur",
      "emoji": "📈",
      "color": "green"
    }
  ]
}
```

Run `npm run init-interactive` to create the wallet, then `npm run swarm` includes it automatically.

### What Breaks at Scale?

- **RPC rate limits**: 100 agents polling every 10 seconds = 600 req/min per agent × 100 = 60k req/min. Needs dedicated RPC or caching layer.
- **Message broker throughput**: HTTP polling doesn't scale to 1000+ agents. Would need WebSockets or message queue (Redis, RabbitMQ).
- **Pool liquidity**: With $1M in trades, the 5 SOL pools would be completely imbalanced. Needs deeper liquidity or multiple pool tiers.

The architecture handles 10-20 agents fine. Beyond that, the communication layer and RPC infrastructure would need replacement.

## Lessons Learned

### What Didn't Work

**Small pool constraint**. The u64 overflow issue with large trades was discovered empirically—transaction simulations succeeded, actual transactions failed. We had to calibrate trade sizes per pool through trial and error. A production system would use u128 math or decimal arithmetic.

**LP token bootstrapping**. The Liquidity Provider agent initially couldn't add liquidity because it had no tokens—only SOL. We added auto-buy logic: if LP wants to add liquidity but has no tokens, it executes a swap first to acquire them. This creates a chicken-and-egg problem that's solved by the Banker providing initial SOL for swaps.

**MessageBus reliability**. Early versions used pure EventEmitter—worked fine in single-process mode, failed completely when agents ran separately. The HTTP broker added complexity but eliminated an entire class of bugs.

### What Surprised Us

**Auto-survival works**. Agents actually do recover from low balance states by liquidating tokens and requesting Banker funds. The system runs for days without intervention.

**Emergent patterns**. Agents don't always behave as expected—the Trend Follower's "force trade after 5 scans" logic was added because otherwise it would sit idle during low-volatility periods. The constraint actually improved performance by ensuring participation.

**P&L tracking complexity**. Calculating true P&L requires tracking cost basis per position, handling partial sells, accounting for fees. We ended up parsing transaction effects from the chain post-execution to get accurate numbers.

### What We'd Build Next

1. **LLM Integration**: Connect agents to language models for natural language strategy descriptions, market analysis, and autonomous decision explanations. An agent could query GPT-4 or Claude to interpret news sentiment and adjust position sizing.

2. **Custom SDK for Agent Wallets**: Extract the WalletManager into a standalone npm package (`@agent-mesh/wallet`) with standardized interfaces for key encryption, transaction batching, and multi-chain support. This would enable other developers to build agent systems without reimplementing custody logic.

3. **Strategy evolution**: Agents that modify their parameters based on performance using on-chain reinforcement learning.

4. **Cross-pool arbitrage**: Detect price differences between AUSDC/SOL and ABTC/SOL, execute triangular arbitrage across all four pools.

5. **Options/derivatives**: Simple on-chain options for hedging positions, allowing agents to buy protection against adverse moves.

6. **Governance token**: Agents vote on protocol parameters (fees, trade sizes, new pool listings) proportional to their accumulated fees.

7. **Mainnet bridge**: Wrapped version using real tokens with proper custody, transitioning from devnet demonstration to production capital allocation.

The core insight: multi-agent systems with economic incentives produce fascinating emergent behavior. The code is the easy part—the emergent coordination is where the value lies.
