/**
 * Volatility Generator - Creates Price Movements for Demo
 * 
 * Treasury executes SEQUENTIAL swaps (buy from one pool, sell to another)
 * to create large price discrepancies across pools.
 * 
 * Run: npx ts-node scripts/volatilityGenerator.ts
 */

import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { Program, AnchorProvider, Wallet, BN } from '@coral-xyz/anchor';
import {
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
} from '@solana/spl-token';
import { Transaction, SystemProgram, BlockhashWithExpiryBlockHeight } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { decryptKeypair, isValidEncryptionKey } from '../src/utils/encryption';
dotenv.config();
const NETWORK = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const PROGRAM_ID = new PublicKey('5LU3snhGuiRYF1u1W3cX8xUYoPbNYiZHKPQgqZgxQJi6');

interface PoolConfig {
  tokenSymbol: string;
  poolId: string;
  vaultA: string;
  vaultB: string;
  mintA: string;
  mintB: string;
  decimalsA: number;
  decimalsB: number;
}

class VolatilityGenerator {
  connection: Connection;
  wallet: Keypair;
  program: Program<any>;
  pools: PoolConfig[] = [];
  
  // Tiny trades to avoid u64 overflow in constant product math
  readonly MIN_TRADE_SOL = 0.001;  // 0.001 SOL (1msol) - smaller to preserve SOL
  readonly MAX_TRADE_SOL = 0.01;   // 0.01 SOL (10msol) - max per trade
  readonly INTERVAL = 15000; // 15s between sequences
  readonly PUMP_THRESHOLD = 0.15; // Pump when price drops 15% from baseline
  readonly MIN_SOL_RESERVE = 0.5; // Keep at least 0.5 SOL for fees
  readonly MAX_SOL_PER_SEQUENCE = 0.05; // Max 0.05 SOL per sequence
  
  private isRunning = false;
  private sequenceCount = 0;
  private startTime: Date | null = null;
  private baselinePrices: Map<string, number> = new Map();
  private lastPumpTime: Map<string, number> = new Map();
  private totalSolSpent = 0;
  private initialBalance: number | null = null;

  constructor() {
    this.connection = new Connection(NETWORK, 'confirmed');
    
    // Load encrypted treasury keypair
    const encryptionKey = process.env.WALLET_ENCRYPTION_KEY || '';
    if (!encryptionKey) {
      throw new Error('WALLET_ENCRYPTION_KEY not found in environment');
    }
    if (!isValidEncryptionKey(encryptionKey)) {
      throw new Error('Invalid WALLET_ENCRYPTION_KEY. Must be 64 hex characters.');
    }
    
    const keypairPath = process.env.TREASURY_KEYPAIR_PATH || './treasury-keypair.enc.json';
    if (!fs.existsSync(keypairPath)) {
      throw new Error(`Treasury keypair not found: ${keypairPath}`);
    }
    
    const encryptedData = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
    const secretKey = decryptKeypair(encryptedData, encryptionKey);
    this.wallet = Keypair.fromSecretKey(secretKey);
    
    console.log(`✅ Loaded treasury: ${this.wallet.publicKey.toString()}`);
    
    const anchorWallet = new Wallet(this.wallet);
    const provider = new AnchorProvider(this.connection, anchorWallet, {
      commitment: 'confirmed',
    });
    
    const idlPath = path.resolve(process.cwd(), 'anchor-amm/app/idl.json');
    const idl = JSON.parse(fs.readFileSync(idlPath, 'utf-8'));
    this.program = new Program(idl, provider);
    
    this.loadPools();
  }

  loadPools(): void {
    const poolPath = path.resolve(process.cwd(), 'pool-configs.json');
    if (fs.existsSync(poolPath)) {
      const configs = JSON.parse(fs.readFileSync(poolPath, 'utf-8'));
      this.pools = Object.values(configs);
      console.log(`📊 Loaded ${this.pools.length} pools`);
    } else {
      throw new Error('No pool configs found!');
    }
  }

  /**
   * Get current prices from all pools
   */
  async getPrices(): Promise<Map<string, number>> {
    const prices = new Map<string, number>();
    
    for (const pool of this.pools) {
      try {
        const vaultA = new PublicKey(pool.vaultA);
        const vaultB = new PublicKey(pool.vaultB);
        
        const [tokenBal, solBal] = await Promise.all([
          this.connection.getTokenAccountBalance(vaultA),
          this.connection.getTokenAccountBalance(vaultB),
        ]);
        
        const tokenReserve = Number(tokenBal.value.amount) / 10 ** pool.decimalsA;
        const solReserve = Number(solBal.value.amount) / LAMPORTS_PER_SOL;
        const price = tokenReserve / solReserve;
        
        prices.set(pool.tokenSymbol, price);
      } catch (e) {
        console.error(`Failed to get price for ${pool.tokenSymbol}`);
      }
    }
    
    return prices;
  }

  /**
   * Wrap SOL to wSOL for swapping
   */
  async ensureWrappedSol(amount: number): Promise<void> {
    const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, this.wallet.publicKey);
    
    // Check current wSOL balance
    try {
      const account = await this.connection.getTokenAccountBalance(wsolAta);
      const currentBalance = Number(account.value.amount) / LAMPORTS_PER_SOL;
      if (currentBalance >= amount) {
        return; // Already enough wSOL
      }
    } catch {
      // Account doesn't exist, will create
    }
    
    // Wrap SOL
    const wrapAmount = Math.floor(amount * LAMPORTS_PER_SOL);
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        this.wallet.publicKey,
        wsolAta,
        this.wallet.publicKey,
        NATIVE_MINT
      ),
      SystemProgram.transfer({
        fromPubkey: this.wallet.publicKey,
        toPubkey: wsolAta,
        lamports: wrapAmount,
      }),
      createSyncNativeInstruction(wsolAta)
    );
    
    const { blockhash } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = this.wallet.publicKey;
    tx.sign(this.wallet);
    
    await this.connection.sendRawTransaction(tx.serialize());
    console.log(`   💧 Wrapped ${amount} SOL → wSOL`);
    
    // Wait for confirmation
    await new Promise(r => setTimeout(r, 2000));
  }

  /**
   * Execute a single swap
   */
  async executeSwap(
    pool: PoolConfig, 
    direction: 'A_TO_B' | 'B_TO_A', 
    amount: number
  ): Promise<string> {
    const poolPda = new PublicKey(pool.poolId);
    const vaultA = new PublicKey(pool.vaultA);
    const vaultB = new PublicKey(pool.vaultB);
    const mintA = new PublicKey(pool.mintA);
    
    await getOrCreateAssociatedTokenAccount(
      this.connection, this.wallet, mintA, this.wallet.publicKey
    );
    
    const userTokenA = getAssociatedTokenAddressSync(mintA, this.wallet.publicKey);
    const userTokenB = getAssociatedTokenAddressSync(NATIVE_MINT, this.wallet.publicKey);
    
    const decimalsIn = direction === 'B_TO_A' ? 9 : pool.decimalsA;
    const amountInRaw = new BN(Math.floor(amount * 10 ** decimalsIn));
    const minAmountOutRaw = new BN(0);
    
    const aToB = direction === 'A_TO_B';
    
    const tx = await (this.program.methods as any)
      .swap(amountInRaw, minAmountOutRaw, aToB)
      .accounts({
        user: this.wallet.publicKey,
        pool: poolPda,
        userTokenA: userTokenA,
        userTokenB: userTokenB,
        vaultA: vaultA,
        vaultB: vaultB,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([this.wallet])
      .rpc();
    
    return tx;
  }

  /**
   * Execute sequential trades to create price divergence
   * Randomly chooses direction to create both uptrends and downtrends
   */
  async executeSequence(): Promise<void> {
    // Check SOL balance first
    const solBalance = await this.connection.getBalance(this.wallet.publicKey);
    const solBalanceSol = solBalance / LAMPORTS_PER_SOL;
    
    if (solBalanceSol < this.MIN_SOL_RESERVE + this.MIN_TRADE_SOL) {
      console.log(`\n⚠️  LOW BALANCE: ${solBalanceSol.toFixed(4)} SOL`);
      console.log(`   Need at least ${(this.MIN_SOL_RESERVE + this.MIN_TRADE_SOL).toFixed(4)} SOL to trade`);
      console.log(`   Please fund treasury with more SOL`);
      console.log(`   Address: ${this.wallet.publicKey.toString()}`);
      await new Promise(r => setTimeout(r, 30000)); // Wait 30s before checking again
      return;
    }
    
    // Calculate dynamic trade size based on available balance
    const maxAffordable = solBalanceSol - this.MIN_SOL_RESERVE;
    const maxTradeSize = Math.min(this.MAX_TRADE_SOL, maxAffordable / 2); // Use half max affordable per trade
    
    if (maxTradeSize < this.MIN_TRADE_SOL) {
      console.log(`\n⚠️  Cannot afford minimum trade size`);
      return;
    }
    
    // Pick two different pools
    const poolA = this.pools[Math.floor(Math.random() * this.pools.length)];
    let poolB = this.pools[Math.floor(Math.random() * this.pools.length)];
    while (poolB.tokenSymbol === poolA.tokenSymbol) {
      poolB = this.pools[Math.floor(Math.random() * this.pools.length)];
    }
    
    // Use smaller trade sizes to preserve SOL
    const tradeSize = this.MIN_TRADE_SOL + Math.random() * (maxTradeSize - this.MIN_TRADE_SOL);
    
    // Stay within budget
    const estimatedCost = tradeSize * 2.5; // Account for 2 trades + fees
    if (estimatedCost > this.MAX_SOL_PER_SEQUENCE) {
      console.log(`\n⏸️  Skipping: would exceed max SOL per sequence (${this.MAX_SOL_PER_SEQUENCE} SOL)`);
      return;
    }
    
    // Get prices before
    const pricesBefore = await this.getPrices();
    
    // Update baselines on first run
    for (const [sym, price] of pricesBefore) {
      if (!this.baselinePrices.has(sym)) {
        this.baselinePrices.set(sym, price);
      }
    }
    
    // Detect and reverse large drops
    const tokenToPump = this.findTokenToPump(pricesBefore);
    
    if (tokenToPump) {
      // PUMP MODE: Force buy to create uptrend
      console.log(`\n🚀 PUMP SEQUENCE #${this.sequenceCount + 1}`);
      console.log(`   ${tokenToPump} dropped >${(this.PUMP_THRESHOLD*100).toFixed(0)}% from baseline!`);
      console.log(`   Action: HEAVY BUY to create uptrend`);
      await this.executePump(tokenToPump, tradeSize * 2, pricesBefore);
      return;
    }
    
    // Normal volatility: Randomly choose strategy
    const strategy = Math.random() > 0.5 ? 'UP_DOWN' : 'DOWN_UP';
    
    console.log(`\n🔄 SEQUENCE #${this.sequenceCount + 1}`);
    if (strategy === 'UP_DOWN') {
      console.log(`   Strategy: Buy ${poolA.tokenSymbol} (UP) → Sell ${poolB.tokenSymbol} (DOWN)`);
    } else {
      console.log(`   Strategy: Sell ${poolA.tokenSymbol} (DOWN) → Buy ${poolB.tokenSymbol} (UP)`);
    }
    console.log(`   Trade Size: ${tradeSize.toFixed(3)} SOL`);
    
    console.log('   Prices BEFORE:');
    for (const [sym, price] of Array.from(pricesBefore.entries())) {
      const baseline = this.baselinePrices.get(sym) || price;
      const change = ((price - baseline) / baseline) * 100;
      console.log(`      ${sym}: ${price.toFixed(2)} (${change > 0 ? '+' : ''}${change.toFixed(1)}% from baseline)`);
    }
    
    if (strategy === 'UP_DOWN') {
      await this.executeUpDown(poolA, poolB, tradeSize, pricesBefore);
    } else {
      await this.executeDownUp(poolA, poolB, tradeSize, pricesBefore);
    }
  }

  /**
   * Find a token that dropped too much and needs a pump
   */
  findTokenToPump(prices: Map<string, number>): string | null {
    const now = Date.now();
    
    for (const [sym, price] of prices) {
      const baseline = this.baselinePrices.get(sym);
      if (!baseline) continue;
      
      const drop = (baseline - price) / baseline;
      const lastPump = this.lastPumpTime.get(sym) || 0;
      const timeSincePump = now - lastPump;
      
      // Pump if dropped >15% and hasn't been pumped in last 60 seconds
      if (drop > this.PUMP_THRESHOLD && timeSincePump > 60000) {
        return sym;
      }
    }
    return null;
  }

  /**
   * Execute a PUMP - heavy buying to create uptrend
   */
  async executePump(tokenSymbol: string, tradeSize: number, pricesBefore: Map<string, number>): Promise<void> {
    const pool = this.pools.find(p => p.tokenSymbol === tokenSymbol);
    if (!pool) return;
    
    // Wrap SOL for trading
    await this.ensureWrappedSol(tradeSize * 1.1);
    
    // Execute 3 consecutive buys to push price UP significantly
    console.log(`\n   Executing 3 consecutive buys...`);
    
    for (let i = 1; i <= 3; i++) {
      console.log(`   Buy #${i}...`);
      try {
        const tx = await this.executeSwap(pool, 'B_TO_A', tradeSize / 3);
        console.log(`   ✅ Buy #${i} complete: ${tx.slice(0, 30)}...`);
      } catch (e: any) {
        console.error(`   ❌ Buy #${i} failed:`, e.message);
      }
      await new Promise(r => setTimeout(r, 1500));
    }
    
    // Update baseline and pump time
    const newPrice = (await this.getPrices()).get(tokenSymbol) || pricesBefore.get(tokenSymbol)!;
    this.baselinePrices.set(tokenSymbol, newPrice * 0.95); // New baseline 5% below current
    this.lastPumpTime.set(tokenSymbol, Date.now());
    
    console.log(`\n   🚀 PUMP COMPLETE for ${tokenSymbol}`);
    const before = pricesBefore.get(tokenSymbol)!;
    const change = ((newPrice - before) / before) * 100;
    console.log(`   Price change: ${change.toFixed(2)}%`);
    
    this.sequenceCount++;
  }

  /**
   * Strategy: Buy A (push UP) → Sell B (push DOWN)
   */
  async executeUpDown(poolA: PoolConfig, poolB: PoolConfig, tradeSize: number, pricesBefore: Map<string, number>): Promise<void> {
    // STEP 0: Ensure wSOL for trading
    console.log(`\n   Step 0: Wrapping SOL...`);
    await this.ensureWrappedSol(tradeSize * 1.1);
    
    // STEP 1: Buy from Pool A (SOL → Token) - PUSHES PRICE UP
    console.log(`\n   Step 1: BUY from ${poolA.tokenSymbol} pool (pushes UP)`);
    try {
      const tx1 = await this.executeSwap(poolA, 'B_TO_A', tradeSize);
      console.log(`   ✅ Buy complete: ${tx1.slice(0, 30)}...`);
    } catch (e: any) {
      console.error(`   ❌ Buy failed:`, e.message);
      return;
    }
    
    await new Promise(r => setTimeout(r, 2000));
    
    // STEP 2: Sell to Pool B (Token → SOL) - PUSHES PRICE DOWN
    console.log(`\n   Step 2: SELL to ${poolB.tokenSymbol} pool (pushes DOWN)`);
    try {
      const tx2 = await this.executeSwap(poolB, 'A_TO_B', tradeSize);
      console.log(`   ✅ Sell complete: ${tx2.slice(0, 30)}...`);
    } catch (e: any) {
      console.error(`   ❌ Sell failed:`, e.message);
    }
    
    await this.printPriceChanges(pricesBefore);
  }

  /**
   * Strategy: Sell A (push DOWN) → Buy B (push UP)
   */
  async executeDownUp(poolA: PoolConfig, poolB: PoolConfig, tradeSize: number, pricesBefore: Map<string, number>): Promise<void> {
    // STEP 0: Wrap enough for BOTH trades (buy inventory + buy pool B)
    // Need: tradeSize (for inventory) + tradeSize (for pool B) + fees
    console.log(`\n   Step 0: Wrapping SOL for both trades...`);
    await this.ensureWrappedSol(tradeSize * 2.2); // 2x trade + buffer
    
    // STEP 0b: Buy inventory
    console.log(`   Buying ${poolA.tokenSymbol} inventory...`);
    try {
      const buyTx = await this.executeSwap(poolA, 'B_TO_A', tradeSize);
      console.log(`   ✅ Bought inventory: ${buyTx.slice(0, 30)}...`);
    } catch (e: any) {
      console.error(`   ❌ Failed to buy inventory:`, e.message);
      return;
    }
    
    await new Promise(r => setTimeout(r, 2000));
    
    // STEP 1: Sell to Pool A (Token → SOL) - PUSHES PRICE DOWN
    console.log(`\n   Step 1: SELL to ${poolA.tokenSymbol} pool (pushes DOWN)`);
    try {
      const tx1 = await this.executeSwap(poolA, 'A_TO_B', tradeSize);
      console.log(`   ✅ Sell complete: ${tx1.slice(0, 30)}...`);
    } catch (e: any) {
      console.error(`   ❌ Sell failed:`, e.message);
      return;
    }
    
    await new Promise(r => setTimeout(r, 2000));
    
    // STEP 2: Buy from Pool B (SOL → Token) - PUSHES PRICE UP
    console.log(`\n   Step 2: BUY from ${poolB.tokenSymbol} pool (pushes UP)`);
    try {
      const tx2 = await this.executeSwap(poolB, 'B_TO_A', tradeSize);
      console.log(`   ✅ Buy complete: ${tx2.slice(0, 30)}...`);
    } catch (e: any) {
      console.error(`   ❌ Buy failed:`, e.message);
    }
    
    await this.printPriceChanges(pricesBefore);
  }

  /**
   * Print price changes after trades
   */
  async printPriceChanges(pricesBefore: Map<string, number>): Promise<void> {
    await new Promise(r => setTimeout(r, 2000));
    
    const pricesAfter = await this.getPrices();
    console.log('\n   Prices AFTER:');
    for (const [sym, price] of Array.from(pricesAfter.entries())) {
      const before = pricesBefore.get(sym) || price;
      const change = ((price - before) / before) * 100;
      const arrow = change > 0 ? '↑' : change < 0 ? '↓' : '→';
      console.log(`      ${sym}: ${price.toFixed(2)} ${arrow} ${change.toFixed(2)}%`);
    }
    
    const valuesA = Array.from(pricesAfter.values());
    const min = Math.min(...valuesA);
    const max = Math.max(...valuesA);
    const spread = ((max - min) / min) * 100;
    console.log(`\n   📊 SPREAD CREATED: ${spread.toFixed(2)}%`);
    
    if (spread > 1) {
      console.log('   🎯 ARBITRAGE OPPORTUNITY AVAILABLE!');
    }
    
    this.sequenceCount++;
  }

  /**
   * Print status
   */
  async printStatus(): Promise<void> {
    const balance = await this.connection.getBalance(this.wallet.publicKey);
    const balanceSol = balance / LAMPORTS_PER_SOL;
    const prices = await this.getPrices();
    
    // Track SOL spent
    if (this.sequenceCount === 0) {
      this.initialBalance = balanceSol;
    }
    this.totalSolSpent = (this.initialBalance || balanceSol) - balanceSol;
    
    console.log('\n' + '='.repeat(60));
    console.log('📊 VOLATILITY GENERATOR STATUS');
    console.log(`   SOL Balance: ${balanceSol.toFixed(4)} SOL`);
    console.log(`   SOL Spent: ${this.totalSolSpent.toFixed(4)} SOL`);
    console.log(`   Sequences: ${this.sequenceCount}`);
    console.log(`   SOL/Seq: ${this.sequenceCount > 0 ? (this.totalSolSpent / this.sequenceCount).toFixed(4) : '0'} SOL`);
    
    if (balanceSol < this.MIN_SOL_RESERVE * 2) {
      console.log(`   ⚠️  LOW BALANCE WARNING!`);
      console.log(`   Fund: ${this.wallet.publicKey.toString()}`);
    }
    
    console.log('   Prices (vs baseline):');
    
    for (const [symbol, price] of Array.from(prices.entries())) {
      const baseline = this.baselinePrices.get(symbol);
      if (baseline) {
        const change = ((price - baseline) / baseline) * 100;
        const arrow = change > 0 ? '↑' : change < 0 ? '↓' : '→';
        console.log(`      ${symbol}: ${price.toFixed(2)} ${arrow} ${change.toFixed(1)}%`);
      } else {
        console.log(`      ${symbol}: ${price.toFixed(2)} (setting baseline)`);
        this.baselinePrices.set(symbol, price);
      }
    }
    
    const values = Array.from(prices.values());
    const min = Math.min(...values);
    const max = Math.max(...values);
    const spread = ((max - min) / min) * 100;
    
    console.log(`   Spread: ${spread.toFixed(2)}%`);
    console.log(`   Sequences executed: ${this.sequenceCount}`);
    
    if (this.startTime) {
      const elapsed = (Date.now() - this.startTime.getTime()) / 1000 / 60;
      console.log(`   Runtime: ${elapsed.toFixed(1)} min`);
    }
    console.log('='.repeat(60));
  }

  /**
   * Main loop
   */
  async run(): Promise<void> {
    this.isRunning = true;
    this.startTime = new Date();
    
    console.log('='.repeat(70));
    console.log('  VOLATILITY GENERATOR - SEQUENTIAL TRADES');
    console.log('  Creates price divergence for arbitrage opportunities');
    console.log('='.repeat(70));
    console.log(`\nTreasury: ${this.wallet.publicKey.toBase58()}`);
    console.log('Strategy: Buy from Pool A → Sell to Pool B');
    console.log('Effect: Pushes prices apart, creating arbitrage\n');
    
    // Initial status
    await this.printStatus();
    
    while (this.isRunning) {
      try {
        // Execute sequence
        await this.executeSequence();
        
        // Status every 3 sequences
        if (this.sequenceCount % 3 === 0) {
          await this.printStatus();
        }
        
        // Wait before next sequence
        console.log(`\n   ⏳ Next sequence in ${(this.INTERVAL / 1000).toFixed(0)}s...`);
        await new Promise(r => setTimeout(r, this.INTERVAL));
        
      } catch (error: any) {
        console.error('\n❌ Error:', error.message);
        await new Promise(r => setTimeout(r, 10000));
      }
    }
  }

  stop(): void {
    this.isRunning = false;
    console.log('\n🛑 Volatility generator stopped');
    console.log(`   Total sequences: ${this.sequenceCount}`);
  }
}

// Main
async function main() {
  const generator = new VolatilityGenerator();
  
  process.on('SIGINT', () => {
    generator.stop();
    process.exit(0);
  });
  
  await generator.run();
}

main().catch(console.error);
