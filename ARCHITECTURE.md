# Agent Mesh - Architecture for Judges

## Executive Summary

**Agent Mesh** is a multi-agent economic simulation where 4 AI agents with distinct strategies trade autonomously on a custom Solana AMM, creating emergent market behavior.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           AGENT MESH SWARM                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  ┌──────────┐│
│  │  ARBITRAGEUR    │  │  LIQUIDITY      │  │  TREND FOLLOWER │  │ VOLATILITY││
│  │     AGENT       │  │   PROVIDER      │  │     AGENT       │  │ GENERATOR ││
│  │                 │  │                 │  │                 │  │(Treasury) ││
│  │ • Buy dips      │  │ • Add liquidity │  │ • MA crossover  │  │ • Random  ││
│  │ • Sell rallies  │  │ • TVL-based adds│  │ • Trend follow  │  │   swaps   ││
│  │ • 0.2% threshold│  │ • 0.1-1 SOL/add │  │ • 15s scans     │  │ • Creates ││
│  │ • 5min scans    │  │ • 1min scans    │  │ • 5min warm-up  │  │   action  ││
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘  └─────┬─────┘│
│           │                    │                    │                  │      │
│           └────────────────────┴────────────────────┘                  │      │
│                              │                                         │      │
│                    ┌─────────▼─────────┐                               │      │
│                    │   CUSTOM AMM      │                               │      │
│                    │   (Anchor Program)│                               │      │
│                    │                   │                               │      │
│                    │ • 4 Token Pools   │◄──────────────────────────────┘      │
│                    │ • Constant Product│                                      │
│                    │ • 5 SOL Depth Each│                                      │
│                    └───────────────────┘                                      │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Components

### 1. Custom AMM Protocol (Anchor)

**Program ID**: `5LU3snhGuiRYF1u1W3cX8xUYoPbNYiZHKPQgqZgxQJi6`

| Pool | Token Mint | Liquidity | Initial Price |
|------|-----------|-----------|---------------|
| AUSDC/SOL | `B7tFhVdFeafrdBcCEWsjDXr3rUqkwXMmtbDKkJDy6PqE` | 500 AUSDC + 5 SOL | 1 SOL = 100 AUSDC |
| ABTC/SOL | `eL6FAw3nzY8ftwjwtgJnGWAdb4aNZHmsK5H39f2F4tN` | 5 ABTC + 5 SOL | 1 SOL = 1 ABTC |
| AETH/SOL | `8L4wBtjbS4bjJXDhg8QHpVkvNfqamvCddAzqtMetr1DC` | 50 AETH + 5 SOL | 1 SOL = 10 AETH |
| ASOL/SOL | `4XXFcpZM7w2RD2r8nQz2UST67f8kef4JohPzp1Y72Y69` | 500 ASOL + 5 SOL | 1 SOL = 100 ASOL |

**Features**:
- Constant product formula (x * y = k)
- PDA-based vaults
- Slippage protection
- u64 safe (no overflow with small trades)

### 2. Agents

#### ArbitrageurAgent (`arbitrageur-01`)
```typescript
Strategy: Price Momentum
- BUY when price drops >0.2% (buy the dip)
- SELL when price rises >0.2% (take profit)
- Trade sizes: 0.005-0.05 SOL per pool
- Scan interval: 5 minutes
```

#### LiquidityProviderAgent (`liquidity-provider-02`)
```typescript
Strategy: TVL-Based Liquidity Provision
- Adds liquidity when pool TVL < 10 SOL
- Add amount: 0.1-1 SOL based on attractiveness
- Max 3 adds per hour per pool
- One-way adds (no removal for safety)
```

#### TrendFollowerAgent (`trend-follower-04`)
```typescript
Strategy: Moving Average Crossover
- MA5 vs MA20 crossover detection
- BUY on uptrend (MA5 > MA20)
- SELL on downtrend (MA5 < MA20)
- 15-second scans for fast response
```

#### VolatilityGenerator (Treasury)
```typescript
Role: Market Maker / Price Discovery
- Executes random swaps every 10 seconds
- Bidirectional: 50% UP_DOWN, 50% DOWN_UP
- Creates price movements for agents to trade
- Auto-pumps tokens that drop >15%
```

### 3. Wallet Infrastructure

| Wallet | Address | SOL | Tokens |
|--------|---------|-----|--------|
| Treasury | `DrArheKBADE6aSDF7ZqurdC4XYexSmBuBbFwk7pXAiwP` | ~5.8 | ~1M each |
| Arbitrageur | `BtEHWkjdy2tpQbnRaaZBCNR8ta9nTD8KaZaN1dHtECpd` | 1.0 | 2K AUSDC, 1.5 ABTC, 4 AETH, 20 ASOL |
| Liquidity Provider | `BfXGgQEWnfusEZv6qvvSyUtBzKj3AkVMfu65uZJntjoH` | 1.0 | 10K AUSDC, 7 ABTC, 15 AETH, 100 ASOL |
| Market Maker | `oYuCrBqckLF62RbSqJufwUB9g1waRboCHzsbC8ATagr` | 1.0 | 4K AUSDC, 3 ABTC, 10 AETH, 40 ASOL |
| Trend Follower | `6kLERsvPrjREAx8SR6Dz5SsAC56DbKRfve8R8auFrx5C` | 1.0 | 2K AUSDC, 1.5 ABTC, 4 AETH, 20 ASOL |

---

## Emergent Behavior

When all agents run simultaneously:

1. **Volatility Generator** creates price movements
2. **Arbitrageur** buys dips, sells rallies
3. **Trend Follower** follows sustained trends
4. **Liquidity Provider** adds depth during volatility
5. **Result**: Self-sustaining trading ecosystem

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Blockchain | Solana Devnet |
| Smart Contracts | Anchor Framework (Rust) |
| Client | TypeScript + @coral-xyz/anchor |
| Token Standard | SPL Token (Metaplex metadata) |
| RPC | Alchemy / Helius |

---

## Key Transactions

| Type | Example Explorer Link |
|------|----------------------|
| Pool Creation | https://explorer.solana.com/address/6coUhjgmVqzgdbMYAfZaMRBKWHFjTRAWZJ7HcPre1qsr?cluster=devnet |
| Token Mint | https://explorer.solana.com/address/B7tFhVdFeafrdBcCEWsjDXr3rUqkwXMmtbDKkJDy6PqE?cluster=devnet |
| Swap | (Live trading - check logs) |

---

## Demo Commands

```bash
# Start volatility (Terminal 1)
npm run volatility

# Start agents (Terminals 2-4)
npm run dev                           # Arbitrageur
AGENT_TYPE=LP npm run dev            # Liquidity Provider
AGENT_TYPE=TREND npm run dev         # Trend Follower

# Monitor
npm run check-all
```

---

## What Makes This Special

1. **Custom AMM**: Not using Jupiter/Raydium - built our own
2. **Multi-Agent**: 4 agents with different strategies
3. **Emergent Behavior**: Agents create a mini economy
4. **Real Trading**: Live swaps on Solana devnet
5. **Autonomous**: No human intervention needed

**This is an economic simulation, not just a trading bot.**
