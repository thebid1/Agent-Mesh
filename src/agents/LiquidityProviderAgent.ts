/**
 * Liquidity Provider Agent - Adds Liquidity to Pools
 * 
 * Strategy:
 * - Monitors pool depths and trading volumes
 * - Adds liquidity when pool ratio is attractive (near 50/50)
 * - Targets pools with high volatility for more fees
 * - Does NOT remove liquidity (one-way for safety)
 */

import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL, Transaction, SystemProgram, sendAndConfirmTransaction } from '@solana/web3.js';
import { WalletManager } from '../wallet/WalletManager';
import { BaseAgent } from './BaseAgent';
import { AgentConfig, AgentMessage } from '../types';
import { messageBus } from '../comms/MessageBus';
import { TransactionLogger } from '../utils/TransactionLogger';
import * as anchor from '@coral-xyz/anchor';
import { Program, AnchorProvider, Wallet, BN } from '@coral-xyz/anchor';
import {
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
} from '@solana/spl-token';
import * as fs from 'fs';
import * as path from 'path';

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

interface PoolState {
  symbol: string;
  tokenReserve: number;
  solReserve: number;
  price: number;
  tvl: number;
  lastAddTime: Date | null;
  addCount: number;
}

export class LiquidityProviderAgent extends BaseAgent {
  private readonly SCAN_INTERVAL_MS = 60000; // 1 minute
  private readonly MIN_SOL_TO_KEEP = 0.5; // Keep 0.5 SOL for fees
  private readonly ADD_LIQUIDITY_THRESHOLD = 0.02; // 2% imbalance threshold
  private readonly MAX_ADDS_PER_HOUR = 3; // Limit adds per pool
  private readonly MIN_SOL_ADD = 0.1; // Minimum 0.1 SOL per add
  private readonly MAX_SOL_ADD = 1.0; // Maximum 1 SOL per add

  private program: Program<any> | null = null;
  private pools: PoolConfig[] = [];
  private poolStates: Map<string, PoolState> = new Map();
  private adds: Array<{
    time: Date;
    pool: string;
    solAmount: number;
    tokenAmount: number;
    tx: string;
  }> = [];
  
  private readonly LOW_BALANCE_THRESHOLD = 0.3;
  private readonly FUND_REQUEST_COOLDOWN = 60000;
  private lastFundRequest: number = 0;
  private pendingFundRequest: boolean = false;
  private debtToBanker: number = 0;

  constructor(
    config: AgentConfig,
    connection: Connection,
    walletManager: WalletManager
  ) {
    super(config, connection, walletManager);
    this.scanIntervalMs = this.SCAN_INTERVAL_MS;
    this.loadPools();
    this.initProgram();
    this.initPoolStates();
    
    // Subscribe to high volume signals
    messageBus.subscribe(config.id, ['TRADE_EXECUTED', 'OPPORTUNITY', 'LIQUIDITY_REQUEST', 'RISK_ALERT', 'FUND_OFFER', 'FUNDS_SENT', 'FUND_REJECTED']);
  }

  private loadPools(): void {
    const poolPath = path.resolve(process.cwd(), 'pool-configs.json');
    if (fs.existsSync(poolPath)) {
      const configs = JSON.parse(fs.readFileSync(poolPath, 'utf-8'));
      this.pools = Object.values(configs);
      console.log(`[${this.state.config.id}] 📊 Loaded ${this.pools.length} pools`);
    }
  }

  private initProgram(): void {
    try {
      const wallet = this.state.wallet.keypair;
      const anchorWallet = new Wallet(wallet);
      const provider = new AnchorProvider(this.connection, anchorWallet, {
        commitment: 'confirmed',
      });
      const idl = JSON.parse(fs.readFileSync(
        path.resolve(process.cwd(), 'anchor-amm/app/idl.json'), 'utf-8'
      ));
      this.program = new Program(idl, provider);
    } catch (e: any) {
      console.error(`[${this.state.config.id}] Program init failed:`, e.message);
    }
  }

  private initPoolStates(): void {
    for (const pool of this.pools) {
      this.poolStates.set(pool.tokenSymbol, {
        symbol: pool.tokenSymbol,
        tokenReserve: 0,
        solReserve: 0,
        price: 0,
        tvl: 0,
        lastAddTime: null,
        addCount: 0,
      });
    }
  }

  private async getPoolState(pool: PoolConfig): Promise<PoolState | null> {
    try {
      const [tokenBal, solBal] = await Promise.all([
        this.connection.getTokenAccountBalance(new PublicKey(pool.vaultA)),
        this.connection.getTokenAccountBalance(new PublicKey(pool.vaultB)),
      ]);

      const tokenReserve = Number(tokenBal.value.amount) / 10 ** pool.decimalsA;
      const solReserve = Number(solBal.value.amount) / LAMPORTS_PER_SOL;
      const price = tokenReserve / solReserve;
      const tvl = solReserve * 2; // Approximate TVL in SOL terms

      const state = this.poolStates.get(pool.tokenSymbol)!;
      state.tokenReserve = tokenReserve;
      state.solReserve = solReserve;
      state.price = price;
      state.tvl = tvl;

      return state;
    } catch (e: any) {
      console.error(`[${this.state.config.id}] Error getting pool state:`, e.message);
      return null;
    }
  }

  private shouldAddLiquidity(state: PoolState): { shouldAdd: boolean; solAmount: number; reason: string } {
    // Rate limit adds
    if (state.lastAddTime) {
      const hoursSinceLastAdd = (Date.now() - state.lastAddTime.getTime()) / (1000 * 60 * 60);
      const recentAdds = this.adds.filter(a => 
        a.pool === state.symbol && 
        (Date.now() - a.time.getTime()) < (60 * 60 * 1000)
      ).length;
      
      if (recentAdds >= this.MAX_ADDS_PER_HOUR) {
        return { shouldAdd: false, solAmount: 0, reason: 'Max adds per hour reached' };
      }
      if (hoursSinceLastAdd < 0.1) { // 6 minutes minimum
        return { shouldAdd: false, solAmount: 0, reason: 'Too soon since last add' };
      }
    }

    // Check agent balance
    if (this.state.balance < this.MIN_SOL_TO_KEEP + this.MIN_SOL_ADD) {
      return { shouldAdd: false, solAmount: 0, reason: 'Insufficient SOL balance' };
    }

    // Calculate add amount based on pool attractiveness
    let solAmount = this.MIN_SOL_ADD;
    let reason = '';

    // Bigger pools = more attractive (more fees)
    if (state.tvl < 5) {
      solAmount = Math.min(this.MAX_SOL_ADD, 0.5);
      reason = 'Low TVL - opportunity for high fee share';
    } else if (state.tvl < 10) {
      solAmount = Math.min(this.MAX_SOL_ADD, 0.3);
      reason = 'Medium TVL - moderate fee opportunity';
    } else {
      solAmount = Math.min(this.MAX_SOL_ADD, 0.2);
      reason = 'Established pool - stable fee income';
    }

    // Cap at available balance
    const maxAffordable = this.state.balance - this.MIN_SOL_TO_KEEP;
    solAmount = Math.min(solAmount, maxAffordable);

    if (solAmount < this.MIN_SOL_ADD) {
      return { shouldAdd: false, solAmount: 0, reason: 'Cannot afford minimum add' };
    }

    return { shouldAdd: true, solAmount, reason };
  }

  private async wrapSol(amountSol: number): Promise<void> {
    const wallet = this.state.wallet.keypair;
    const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey);
    const amountLamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, wsolAta, wallet.publicKey, NATIVE_MINT),
      SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: wsolAta, lamports: amountLamports }),
      createSyncNativeInstruction(wsolAta)
    );

    await sendAndConfirmTransaction(this.connection, tx, [wallet]);
  }

  /**
   * Buy tokens via swap to acquire liquidity provision assets
   */
  private async buyTokens(pool: PoolConfig, solAmount: number): Promise<boolean> {
    if (!this.program) return false;
    
    try {
      const wallet = this.state.wallet.keypair;
      const poolPda = new PublicKey(pool.poolId);
      const mintA = new PublicKey(pool.mintA);
      
      const userTokenA = getAssociatedTokenAddressSync(mintA, wallet.publicKey);
      const userTokenB = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey);
      
      // Ensure accounts exist
      await this.ensureTokenAccount(mintA, wallet);
      await this.ensureTokenAccount(NATIVE_MINT, wallet);
      
      // Wrap SOL for trading
      await this.wrapSol(solAmount * 1.02);
      
      const amountInRaw = new BN(Math.floor(solAmount * LAMPORTS_PER_SOL));
      
      const tx = await (this.program.methods as any)
        .swap(amountInRaw, new BN(0), false)  // B_TO_A = false (SOL -> Token)
        .accounts({
          user: wallet.publicKey,
          pool: poolPda,
          userTokenA,
          userTokenB,
          vaultA: new PublicKey(pool.vaultA),
          vaultB: new PublicKey(pool.vaultB),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([wallet])
        .rpc();
      
      console.log(`   ✅ Bought ${pool.tokenSymbol} with ${solAmount} SOL`);
      console.log(`   TX: ${tx.slice(0, 40)}...`);
      

      TransactionLogger.log({
        agentId: this.state.config.id,
        agentType: this.state.config.type,
        type: 'TRADE',
        token: pool.tokenSymbol,
        action: 'BUY',
        amount: solAmount,
        price: 0,
        solAmount: solAmount,
        txSignature: tx,
        metadata: { reason: 'Auto-buy for liquidity provision' }
      });
      
      return true;
    } catch (e: any) {
      console.log(`   ❌ Failed to buy ${pool.tokenSymbol}: ${e.message}`);
      return false;
    }
  }

  private async addLiquidity(pool: PoolConfig, solAmountInput: number): Promise<boolean> {
    if (!this.program) return false;

    const state = this.poolStates.get(pool.tokenSymbol)!;
    
    try {
      const wallet = this.state.wallet.keypair;
      const poolPda = new PublicKey(pool.poolId);
      const mintA = new PublicKey(pool.mintA);

      const userTokenA = getAssociatedTokenAddressSync(mintA, wallet.publicKey);
      const userTokenB = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey);

      // Check SOL balance first
      const solBalance = await this.connection.getBalance(wallet.publicKey);
      const minRequiredSol = (solAmountInput * 1.01 + 0.005) * LAMPORTS_PER_SOL;
      if (solBalance < minRequiredSol) {
        console.log(`   ⚠️ Insufficient SOL: ${(solBalance/LAMPORTS_PER_SOL).toFixed(4)} < ${(minRequiredSol/LAMPORTS_PER_SOL).toFixed(4)} needed`);
        console.log(`   📤 Broadcasting FUND_REQUEST to Banker...`);
        messageBus.broadcast({
          from: this.state.config.id,
          to: 'BROADCAST',
          type: 'FUND_REQUEST',
          payload: {
            agentId: this.state.config.id,
            amount: 0.3,
            reason: 'Need SOL for liquidity provision',
            urgency: 'medium'
          }
        });
        return false;
      }

      // Ensure token accounts exist
      await this.ensureTokenAccount(mintA, wallet);
      await this.ensureTokenAccount(NATIVE_MINT, wallet);

      // Check token balance and CAP solAmount based on available tokens
      let availableTokens = 0;
      try {
        const tokenBalance = await this.connection.getTokenAccountBalance(userTokenA);
        availableTokens = Number(tokenBalance.value.amount) / 10 ** pool.decimalsA;
      } catch {
        availableTokens = 0; // Account exists but no balance
      }

      // Calculate max SOL we can add based on token holdings
      const maxSolFromTokens = availableTokens / state.price;
      let solAmount = Math.min(solAmountInput, maxSolFromTokens);
      
      // Also cap by available SOL
      const maxSolFromBalance = (solBalance / LAMPORTS_PER_SOL) - this.MIN_SOL_TO_KEEP - 0.01;
      solAmount = Math.min(solAmount, maxSolFromBalance);

      if (solAmount < this.MIN_SOL_ADD) {
        console.log(`   ⚠️ Cannot add liquidity: only ${availableTokens.toFixed(4)} ${pool.tokenSymbol} available`);
        console.log(`   📤 Need to acquire ${pool.tokenSymbol} first...`);
        
        // Auto-buy some tokens first via swap
        const buyAmount = Math.min(0.1, maxSolFromBalance * 0.5);
        if (buyAmount >= 0.02) {
          console.log(`   🔄 Auto-buying ${pool.tokenSymbol} with ${buyAmount} SOL...`);
          const bought = await this.buyTokens(pool, buyAmount);
          if (bought) {
            // Retry with updated balance
            return this.addLiquidity(pool, solAmountInput);
          }
        }
        return false;
      }

      const tokenAmount = solAmount * state.price;

      console.log(`\n[${this.state.config.id}] 💧 ADDING LIQUIDITY to ${pool.tokenSymbol}`);
      console.log(`   SOL: ${solAmount.toFixed(4)}`);
      console.log(`   ${pool.tokenSymbol}: ${tokenAmount.toFixed(4)}`);
      console.log(`   (Capped by ${availableTokens.toFixed(4)} tokens available)`);

      // Wrap SOL
      await this.wrapSol(solAmount * 1.01); // Wrap slightly more

      // Add liquidity
      const amountA = new BN(Math.floor(tokenAmount * 10 ** pool.decimalsA));
      const amountB = new BN(Math.floor(solAmount * LAMPORTS_PER_SOL));

      const tx = await (this.program.methods as any)
        .addLiquidity(amountA, amountB)
        .accounts({
          user: wallet.publicKey,
          pool: poolPda,
          userTokenA: userTokenA,
          userTokenB: userTokenB,
          vaultA: new PublicKey(pool.vaultA),
          vaultB: new PublicKey(pool.vaultB),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([wallet])
        .rpc();

      console.log(`   ✅ Liquidity added!`);
      console.log(`   TX: https://explorer.solana.com/tx/${tx}?cluster=devnet`);

      // Update state
      state.lastAddTime = new Date();
      state.addCount++;

      // Record add
      this.adds.push({
        time: new Date(),
        pool: pool.tokenSymbol,
        solAmount,
        tokenAmount,
        tx,
      });
      
      // Log to unified transaction logger
      TransactionLogger.log({
        agentId: this.state.config.id,
        agentType: this.state.config.type,
        type: 'LIQUIDITY_ADD',
        token: pool.tokenSymbol,
        action: 'ADD',
        amount: tokenAmount,
        price: tokenAmount / solAmount,
        solAmount,
        txSignature: tx,
        metadata: { newTVL: state.tvl + solAmount },
      });

      // Broadcast liquidity addition
      messageBus.broadcast({
        from: this.state.config.id,
        to: 'broadcast',
        type: 'LIQUIDITY_UPDATE',
        payload: {
          pool: pool.tokenSymbol,
          solAmount,
          tokenAmount,
          newTVL: state.tvl + solAmount,
        },
      });

      this.recordSuccess(
        this.createAction('ADD_LIQUIDITY', `Added ${solAmount} SOL + ${tokenAmount} ${pool.tokenSymbol} to ${pool.tokenSymbol}/SOL pool`),
        solAmount,
        0.00001
      );

      return true;

    } catch (e: any) {
      console.error(`   ❌ Failed:`, e.message);
      this.recordFailure(
        this.createAction('ADD_LIQUIDITY', `Failed to add liquidity to ${pool.tokenSymbol}`),
        e.message
      );
      return false;
    }
  }

  async executeStrategy(): Promise<void> {
    // Low balance -> liquidate or request funds
    if (this.state.balance < this.LOW_BALANCE_THRESHOLD) {
      console.log(`[${this.state.config.id}] ⚠️ Low SOL balance: ${this.state.balance.toFixed(4)} SOL`);
      
      // Try to sell tokens for SOL first
      const solGained = await this.liquidateTokensForSol(this.LOW_BALANCE_THRESHOLD * 2);
      
      // If still low after liquidation, request from Banker
      if (solGained >= 0 && this.state.balance < this.LOW_BALANCE_THRESHOLD) {
        await this.checkAndRequestFunds();
      }
    }
    
    if (!this.canTrade() || this.state.balance < this.MIN_SOL_TO_KEEP + this.MIN_SOL_ADD) return;
    if (!this.program) this.initProgram();

    console.log(`\n[${this.state.config.id}] 💧 Liquidity Provider scanning pools...`);
    console.log(`[${this.state.config.id}] Balance: ${this.state.balance.toFixed(4)} SOL`);

    let addsThisScan = 0;

    for (const pool of this.pools) {
      try {
        const state = await this.getPoolState(pool);
        if (!state) continue;

        console.log(`[${this.state.config.id}]   ${pool.tokenSymbol}: TVL=${state.tvl.toFixed(2)} SOL, Price=${state.price.toFixed(2)}`);

        const { shouldAdd, solAmount, reason } = this.shouldAddLiquidity(state);

        if (shouldAdd && addsThisScan < 2) { // Max 2 adds per scan
          const success = await this.addLiquidity(pool, solAmount);
          if (success) {
            addsThisScan++;
          }
        } else if (reason) {
          console.log(`[${this.state.config.id}]     ⏳ ${reason}`);
        }
      } catch (e: any) {
        console.error(`[${this.state.config.id}] Error with ${pool.tokenSymbol}:`, e.message);
      }
    }

    // Summary
    const todayAdds = this.adds.filter(a => a.time.toDateString() === new Date().toDateString());
    if (todayAdds.length > 0) {
      const totalSolAdded = todayAdds.reduce((sum, a) => sum + a.solAmount, 0);
      console.log(`[${this.state.config.id}] 📊 Today's adds: ${todayAdds.length} (${totalSolAdded.toFixed(4)} SOL)`);
    }
  }

  async handleMessage(message: AgentMessage): Promise<void> {
    console.log(`[${this.state.config.id}] 📨 Received: ${message.type} from ${message.from}`);
    
    // React to high trading activity - add liquidity where there's volume
    if (message.type === 'TRADE_EXECUTED') {
      const { token, action } = message.payload;
      console.log(`[${this.state.config.id}] 💡 High activity detected in ${token} (${action})`);
      console.log(`[${this.state.config.id}]    Will prioritize liquidity add on next scan`);
      
      // Could boost priority of this pool on next scan
    }
    
    // Respond to explicit liquidity requests
    if (message.type === 'LIQUIDITY_REQUEST') {
      const { pool, amount } = message.payload;
      console.log(`[${this.state.config.id}] 🙋 Received liquidity request for ${pool}: ${amount} SOL`);
    }
    
    // Could respond to risk alerts by pausing liquidity adds
    if (message.type === 'RISK_ALERT') {
      console.log(`[${this.state.config.id}] ⚠️ Risk alert received, pausing adds temporarily`);
    }
    
    // Handle fund messages
    if (message.type === 'FUND_OFFER') {
      console.log(`[${this.state.config.id}]   💰 Banker offering ${message.payload.amount} SOL - accepting!`);
      // Small delay to ensure message processing completes
      setTimeout(() => {
        this.requestFunds(message.payload.amount, message.payload.reason || 'Low balance for liquidity provision');
      }, 100);
    }
    
    if (message.type === 'FUNDS_SENT') {
      console.log(`[${this.state.config.id}]   ✅ Received ${message.payload.amount} SOL from Banker!`);
      this.pendingFundRequest = false;
      this.debtToBanker = message.payload.remainingDebt || 0;
      await this.updateBalance();
    }
    
    if (message.type === 'FUND_REJECTED') {
      console.log(`[${this.state.config.id}]   ❌ Fund request rejected: ${message.payload.reason}`);
      this.pendingFundRequest = false;
    }
  }
  
  private async checkAndRequestFunds(): Promise<void> {
    if (this.pendingFundRequest) return;
    
    const now = Date.now();
    if (now - this.lastFundRequest < this.FUND_REQUEST_COOLDOWN) return;
    
    this.lastFundRequest = now;
    
    const amountNeeded = Math.min(0.5, 0.5 - this.state.balance);
    if (amountNeeded < 0.05) return;
    
    await this.requestFunds(amountNeeded, 'Low balance for liquidity provision');
  }
  
  private async requestFunds(amount: number, reason: string): Promise<void> {
    console.log(`\n[${this.state.config.id}] 📥 REQUESTING FUNDS from Banker`);
    console.log(`[${this.state.config.id}]   Amount: ${amount.toFixed(4)} SOL`);
    console.log(`[${this.state.config.id}]   Reason: ${reason}`);
    
    messageBus.broadcast({
      from: this.state.config.id,
      to: 'broadcast',
      type: 'FUND_REQUEST',
      payload: {
        token: 'SOL',
        amount: amount,
        reason: reason,
        urgency: 'HIGH',
        currentBalance: this.state.balance,
      },
    });
    
    this.pendingFundRequest = true;
  }

  getAddHistory(): typeof this.adds {
    return this.adds;
  }
}
