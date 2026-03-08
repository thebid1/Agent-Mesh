# SKILLS.md — Agent Mesh Capability Reference

**Version:** 1.0.0  
**Last Updated:** 2026-03-07  
**For:** AI agents and automated systems interacting with Agent Mesh  
**Network:** Solana Devnet  
**Program:** `5LU3snhGuiRYF1u1W3cX8xUYoPbNYiZHKPQgqZgxQJi6`

---

## SYSTEM OVERVIEW

Agent Mesh is a multi-agent economic simulation on Solana devnet. Four specialized agents trade autonomously against a custom constant-product AMM. Agents communicate via HTTP message broker, request liquidity from a central Banker, and log all transactions to a unified log file.

---

## WALLET OPERATIONS

### Create Agent Wallet

- **Method:** `WalletManager.createAgentWallet(agentId, agentType)`
- **Key Generation:** `Keypair.generate()` — random 32-byte seed
- **Storage:** AES-256-GCM encrypted JSON at `agent-keypairs/<agentId>-keypair.enc.json`
- **Required Env:** `WALLET_ENCRYPTION_KEY` (64-character hex)
- **Returns:** `Promise<PublicKey>`

### Load Agent Wallet

- **Method:** `WalletManager.loadAgentWallets()`
- **Source:** `agents.config.json` defines which agents to load
- **Decryption:** `decryptKeypair(encryptedData, encryptionKey)`
- **Returns:** In-memory `AgentWallet` with `Keypair` attached

### Sign Transaction

- **Flow:** Agent requests operation → WalletManager decrypts key → signs → broadcasts
- **Agent Access:** Never. Agents call `WalletManager.transfer()`, `WalletManager.getBalance()`, etc.
- **Signing Libraries:** `@solana/web3.js` `sendAndConfirmTransaction`

### Transfer SOL Between Agents

```typescript
const result = await walletManager.transfer(
  fromAgentId: string,    // Sender agent ID
  toAgentId: string,      // Recipient agent ID or raw address
  amountSol: number       // Amount in SOL
);
// Returns: { success: boolean, signature?: string, error?: string }
```

---

## AGENT TYPES

### ArbitrageurAgent

- **ID Format:** `arbitrageur-XX` (e.g., `arbitrageur-01`)
- **Strategy:** Price momentum — buy when price drops >0.2%, sell when rises >0.2%
- **Decision Inputs:** Price history (last 5 prices), current position, consecutive buy count
- **Message Subscriptions:** `FUND_OFFER`, `FUNDS_SENT`, `FUND_REJECTED`
- **Trade Conditions:**
  - BUY: `priceChange < -0.002 && tokensHeld === 0`
  - SELL: `priceChange > 0.002 && tokensHeld > 0`
- **Special Behavior:** Auto-sells 50-90% of largest position after 5 consecutive buys
- **Trade Sizes:** AUSDC: 0.02 SOL, ABTC: 0.05 SOL, AETH: 0.005 SOL, ASOL: 0.02 SOL

### TrendFollowerAgent

- **ID Format:** `trend-follower-XX`
- **Strategy:** Moving average crossover (MA3 fast, MA5 slow)
- **Decision Inputs:** 5-period price history, current position, scan count
- **Message Subscriptions:** `OPPORTUNITY`, `TRADE_EXECUTED`, `PRICE_UPDATE`, `FUND_OFFER`, `FUNDS_SENT`, `FUND_REJECTED`
- **Trade Conditions:**
  - BUY: `(ma5 > ma20 && tokensHeld === 0) || (forceTrade && tokensHeld === 0)`
  - SELL: `(ma5 < ma20 && tokensHeld > 0) || (forceTrade && tokensHeld > 0)`
- **Special Behavior:** Force-trades after 5 scans regardless of signal; 3-scan cooldown post-trade
- **Trade Sizes:** Same as ArbitrageurAgent

### LiquidityProviderAgent

- **ID Format:** `liquidity-provider-XX`
- **Strategy:** Add liquidity to pools based on TVL and token availability
- **Decision Inputs:** Pool TVL, recent add history, token balances
- **Message Subscriptions:** `TRADE_EXECUTED`, `OPPORTUNITY`, `LIQUIDITY_REQUEST`, `RISK_ALERT`, `FUND_OFFER`, `FUNDS_SENT`, `FUND_REJECTED`
- **Trade Conditions:**
  - Should add if: `hoursSinceLastAdd > 0.1 && recentAdds < 3 && balance > MIN_SOL_TO_KEEP + MIN_SOL_ADD`
- **Special Behavior:** Auto-buys tokens via swap if insufficient for liquidity add
- **Add Range:** 0.1-1.0 SOL per add (capped by available tokens)

### BankerAgent

- **ID Format:** `banker-XX`
- **Strategy:** Monitor agent balances, provide liquidity when low
- **Decision Inputs:** Agent SOL balances, credit records, trust scores
- **Message Subscriptions:** `FUND_REQUEST`, `FUNDS_REPAYMENT`
- **Funding Conditions:**
  - Auto-transfer when: `agentBalance < 0.3 SOL && (debt < 0.5 || no credit record)`
  - Request evaluation: `trustScore >= 20 && currentDebt <= 1.0 && requestFrequency < 5min`
- **Special Behavior:** Tracks all loans internally; trust score increases on repayment

---

## MESSAGE BUS

### Broker Configuration

- **URL:** `http://localhost:3001` (configurable via `MESSAGE_BROKER_URL` env)
- **Protocol:** HTTP polling
- **Default Poll Interval:** 2000ms

### Endpoints

```
POST   /publish                # Broadcast a message
GET    /messages/:agentId      # Get messages for agent (with type filter)
GET    /messages               # Get all recent messages
GET    /opportunities          # Get recent OPPORTUNITY messages
GET    /sentiment              # Get market sentiment (BULLISH/BEARISH/NEUTRAL)
POST   /clear                  # Clear all messages (testing)
GET    /health                 # Health check
```

### Message Types

| Type | Sender | Receiver | Payload Schema |
|------|--------|----------|----------------|
| `OPPORTUNITY` | Any agent | Broadcast | `{ token, direction, price, amount, reason, confidence }` |
| `TRADE_EXECUTED` | Any agent | Broadcast | `{ token, action, amount, price, pnl, tx }` |
| `PRICE_UPDATE` | Trend Follower | Broadcast | `{ token, direction, price, ma5, ma20, amount, reason, confidence }` |
| `RISK_ALERT` | Any agent | Broadcast | `{ severity, reason, affectedTokens }` |
| `LIQUIDITY_UPDATE` | Liquidity Provider | Broadcast | `{ pool, solAmount, tokenAmount, newTVL }` |
| `LIQUIDITY_REQUEST` | Any agent | Liquidity Provider | `{ pool, amount, urgency }` |
| `FUND_REQUEST` | Any agent | Banker | `{ token, amount, reason, urgency, currentBalance }` |
| `FUNDS_SENT` | Banker | Requester | `{ requestId, token, amount, txSignature, remainingDebt }` |
| `FUND_REJECTED` | Banker | Requester | `{ requestId, reason }` |
| `FUND_OFFER` | Banker | Broadcast | `{ token, amount, reason }` |
| `FUNDS_REPAYMENT` | Any agent | Banker | `{ token, amount, remainingDebt }` |

### Sending a Message

```typescript
import { messageBus } from './comms/MessageBus';

await messageBus.broadcast({
  from: 'arbitrageur-01',
  to: 'broadcast',  // or specific agent ID
  type: 'OPPORTUNITY',
  payload: {
    token: 'AUSDC',
    direction: 'BUY',
    price: 44.5,
    amount: 0.02,
    reason: 'Price dropped 0.5%',
    confidence: 75
  }
});
```

### Receiving Messages

```typescript
// In agent constructor
messageBus.subscribe(this.state.config.id, ['TRADE_EXECUTED', 'PRICE_UPDATE']);

// In agent class
async handleMessage(message: AgentMessage): Promise<void> {
  if (message.type === 'TRADE_EXECUTED') {
    console.log(`${message.from} executed ${message.payload.action} on ${message.payload.token}`);
  }
}
```

---

## AMM INTERACTION

### Program ID

```
5LU3snhGuiRYF1u1W3cX8xUYoPbNYiZHKPQgqZgxQJi6
```

### Available Pools

| Pool | Pool PDA | Token Mint | Decimals |
|------|----------|------------|----------|
| AUSDC | `6coUhjgmVqzgdbMYAfZaMRBKWHFjTRAWZJ7HcPre1qsr` | `B7tFhVdFeafrdBcCEWsjDXr3rUqkwXMmtbDKkJDy6PqE` | 6 |
| ABTC | `34sCQqRaX8ZNJiYjCYHRWeWMfcbHH4n7sgNyLkEnZt6h` | `eL6FAw3nzY8ftwjwtgJnGWAdb4aNZHmsK5H39f2F4tN` | 6 |
| AETH | `5gnjqhtZhZ8vHaWZ8N1sQTcSWZH1qqmLAWjbuo2t8TP4` | `8L4wBtjbS4bjJXDhg8QHpVkvNfqamvCddAzqtMetr1DC` | 6 |
| ASOL | `4PCyaaUSm9dt4R5M736dtncGxrSg8ASbT9pvbMjLLtkf` | `4XXFcpZM7w2RD2r8nQz2UST67f8kef4JohPzp1Y72Y69` | 6 |

All pools pair against wrapped SOL (`So11111111111111111111111111111111111111112`).

### Initialize Anchor Program

```typescript
import * as anchor from '@coral-xyz/anchor';
import { Program, AnchorProvider, Wallet } from '@coral-xyz/anchor';

const idl = JSON.parse(fs.readFileSync('./anchor-amm/app/idl.json', 'utf-8'));
const anchorWallet = new Wallet(keypair);
const provider = new AnchorProvider(connection, anchorWallet, { commitment: 'confirmed' });
const program = new Program(idl, provider);
```

### Execute Swap

```typescript
const tx = await (program.methods as any)
  .swap(
    new BN(amountInRaw),     // Amount in (u64)
    new BN(minAmountOutRaw), // Minimum out (slippage protection)
    aToB                     // true = A→B (token to SOL), false = B→A (SOL to token)
  )
  .accounts({
    user: wallet.publicKey,
    pool: new PublicKey(poolId),
    userTokenA: getAssociatedTokenAddressSync(mintA, wallet.publicKey),
    userTokenB: getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey),
    vaultA: new PublicKey(vaultA),
    vaultB: new PublicKey(vaultB),
    tokenProgram: TOKEN_PROGRAM_ID,
  })
  .signers([wallet])
  .rpc();
```

### Add Liquidity

```typescript
const tx = await (program.methods as any)
  .addLiquidity(
    new BN(amountA),  // Token amount (u64)
    new BN(amountB)   // SOL amount in lamports (u64)
  )
  .accounts({
    user: wallet.publicKey,
    pool: new PublicKey(poolId),
    userTokenA: getAssociatedTokenAddressSync(mintA, wallet.publicKey),
    userTokenB: getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey),
    vaultA: new PublicKey(vaultA),
    vaultB: new PublicKey(vaultB),
    tokenProgram: TOKEN_PROGRAM_ID,
  })
  .signers([wallet])
  .rpc();
```

### Calculate Price

```typescript
const [tokenBal, solBal] = await Promise.all([
  connection.getTokenAccountBalance(new PublicKey(vaultA)),
  connection.getTokenAccountBalance(new PublicKey(vaultB)),
]);

const tokenReserve = Number(tokenBal.value.amount) / 10 ** decimals;
const solReserve = Number(solBal.value.amount) / LAMPORTS_PER_SOL;
const price = tokenReserve / solReserve;  // tokens per SOL
```

---

## SETUP COMMANDS

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript |
| `npm run dev` | Run single agent (set `AGENT_TYPE` env) |
| `npm run swarm` | Launch all agents with color-coded output |
| `npm run dashboard` | Start web dashboard (port 3456) |
| `npm run generate-treasury` | Create encrypted treasury wallet |
| `npm run setup-treasury` | Buy AUSDC/ABTC/AETH/ASOL from pools |
| `npm run init-interactive` | Create agent wallets interactively |
| `npm run fund-interactive` | Fund agents from treasury |
| `npm run volatility` | Start volatility generator (price movements) |
| `npm run check-balances` | Check all wallet balances |
| `npm run check-all` | Check pool balances |

---

## ERROR CODES

| Error | Meaning | Resolution |
|-------|---------|------------|
| `MathOverflow` | u64 overflow in constant product | Reduce trade size |
| `SlippageTooHigh` | Output below minimum | Increase slippage tolerance or reduce trade size |
| `InsufficientFunds` | Not enough SOL for trade + fees | Request funds from Banker or liquidate tokens |
| `AccountNotFound` | Token account doesn't exist | Call `ensureTokenAccount()` before trading |
| `InvalidEncryptionKey` | WALLET_ENCRYPTION_KEY invalid | Verify 64-character hex format |

---

## LIMITATIONS

1. **Devnet only** — All tokens and contracts on Solana devnet
2. **Custom tokens** — AUSDC/ABTC/AETH/ASOL have no real value
3. **Small pools** — ~5 SOL depth per pool
4. **Trade size limits** — Due to u64 math: AETH limited to 0.005 SOL
5. **No Jupiter** — Custom AMM only
6. **Single RPC** — No failover RPC configured
7. **No mainnet path** — Devnet demonstration only

---

## FILE REFERENCES

| File | Purpose |
|------|---------|
| `agents.config.json` | Agent registry (id, type, emoji, color) |
| `wallet-registry.json` | Treasury + agent public keys |
| `pool-configs.json` | Pool PDAs, vaults, mints |
| `token-mints.json` | Token metadata |
| `logs/all-transactions.json` | Unified transaction log |
| `logs/message-bus.json` | Message persistence |
| `agent-keypairs/*.enc.json` | Encrypted private keys |
| `anchor-amm/app/idl.json` | Program interface definition |
