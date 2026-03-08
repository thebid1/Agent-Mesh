/**
 * Trend Follower Agent - Moving Average Crossover Strategy
 * 
 * Strategy:
 * - Calculate 5-period (fast) and 20-period (slow) moving averages
 * - GOLDEN CROSS: MA5 crosses above MA20 → BUY (uptrend starting)
 * - DEATH CROSS: MA5 crosses below MA20 → SELL (downtrend starting)
 * 
 * Works with our AMM pools via swap() function
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

interface PriceHistory {
  symbol: string;
  prices: number[];     // Price history (tokens per SOL)
  timestamps: Date[];
  tokensHeld: number;   // Current position
  avgBuyPrice: number;  // Average entry price
  lastSignal: 'BUY' | 'SELL' | null;  // Last trade signal
  scanCount: number;    // Number of scans since last trade - FORCE TRADE AFTER 5
  cooldownScans: number; // Scans remaining before can trade again (post-trade cooldown)
}

interface TradeOpportunity {
  symbol: string;
  pool: PoolConfig;
  direction: 'BUY' | 'SELL';
  reason: string;
  ma5: number;
  ma20: number;
  amount: number;
}

export class TrendFollowerAgent extends BaseAgent {
  private readonly MA_FAST_PERIOD = 3;    // 3-period MA (fast)
  private readonly MA_SLOW_PERIOD = 5;    // 5-period MA (slow) - TRADE AFTER 5 SCANS
  private readonly SCAN_INTERVAL_MS = 10000; // 10 seconds between scans
  private readonly MIN_CHANGE_PERCENT = 0.001; // 0.1% minimum - ALMOST ALWAYS TRADES
  private readonly FORCE_TRADE_AFTER_SCANS = 5; // Always trade after 5 scans
  
  // Pool-specific trade sizes (same as ArbitrageurAgent)
  private readonly TRADE_SIZES: Record<string, number> = {
    'AUSDC': 0.02,
    'ABTC': 0.05,
    'AETH': 0.005,
    'ASOL': 0.02,
  };

  private lastScanTime: Date | null = null;
  private program: Program<any> | null = null;
  private pools: PoolConfig[] = [];
  private priceHistory: Map<string, PriceHistory> = new Map();
  private trades: Array<{
    time: Date;
    token: string;
    action: 'BUY' | 'SELL';
    price: number;
    ma5: number;
    ma20: number;
    amount: number;
    pnl?: number;
    tx: string;
  }> = [];
  
  private readonly LOW_BALANCE_THRESHOLD = 0.2;
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
    this.scanIntervalMs = this.SCAN_INTERVAL_MS; // 1 minute scans
    this.loadPools();
    this.initProgram();
    this.initPriceHistory();
    
    // Subscribe to MessageBus for opportunities from other agents
    messageBus.subscribe(config.id, ['OPPORTUNITY', 'TRADE_EXECUTED', 'PRICE_UPDATE', 'FUND_OFFER', 'FUNDS_SENT', 'FUND_REJECTED']);
  }

  private loadPools(): void {
    const poolPath = path.resolve(process.cwd(), 'pool-configs.json');
    if (fs.existsSync(poolPath)) {
      const configs = JSON.parse(fs.readFileSync(poolPath, 'utf-8'));
      this.pools = Object.values(configs);
    }
  }

  private initPriceHistory(): void {
    for (const pool of this.pools) {
      this.priceHistory.set(pool.tokenSymbol, {
        symbol: pool.tokenSymbol,
        prices: [],
        timestamps: [],
        tokensHeld: 0,
        avgBuyPrice: 0,
        lastSignal: null,
        scanCount: 0,
        cooldownScans: 0,
      });
    }
  }

  private async initProgram(): Promise<void> {
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

  /**
   * Wrap SOL into wSOL token account before trading
   */
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
    console.log(`[${this.state.config.id}]   💨 Wrapped ${amountSol} SOL for trading`);
  }

  /**
   * Get current price for a pool (tokens per SOL)
   */
  private async getPrice(pool: PoolConfig): Promise<number> {
    const [tokenBal, solBal] = await Promise.all([
      this.connection.getTokenAccountBalance(new PublicKey(pool.vaultA)),
      this.connection.getTokenAccountBalance(new PublicKey(pool.vaultB)),
    ]);

    const tokenReserve = Number(tokenBal.value.amount) / 10 ** pool.decimalsA;
    const solReserve = Number(solBal.value.amount) / LAMPORTS_PER_SOL;

    return tokenReserve / solReserve;
  }

  /**
   * Calculate moving average
   */
  private calculateMA(prices: number[], period: number): number | null {
    if (prices.length < period) return null;
    const recent = prices.slice(-period);
    return recent.reduce((a, b) => a + b, 0) / period;
  }

  /**
   * Update price history and check for MA crossover signals
   * FORCE TRADE after 5 scans regardless of trend strength (for demo visibility)
   */
  private updatePriceHistory(symbol: string, price: number): TradeOpportunity | null {
    const history = this.priceHistory.get(symbol)!;
    
    // Cooldown period after trades
    if (history.cooldownScans > 0) {
      history.cooldownScans--;
      console.log(`[${this.state.config.id}]   ${symbol}: Cooldown... (${history.cooldownScans} scans remaining, collecting fresh data)`);
      
      // Keep collecting prices but DON'T trade
      history.prices.push(price);
      history.timestamps.push(new Date());
      while (history.prices.length > 5) { // Keep fewer during cooldown
        history.prices.shift();
        history.timestamps.shift();
      }
      // DON'T increment scanCount during cooldown
      return null;
    }
    
    // Add new price
    history.prices.push(price);
    history.timestamps.push(new Date());
    
    // Keep only last 5 prices (need exactly MA_SLOW_PERIOD for fresh analysis)
    while (history.prices.length > this.MA_SLOW_PERIOD) {
      history.prices.shift();
      history.timestamps.shift();
    }

    // Increment scan count only when NOT in cooldown
    history.scanCount++;

    // Need at least 5 prices for MA5
    if (history.prices.length < this.MA_SLOW_PERIOD) {
      console.log(`[${this.state.config.id}] ⏳ Collecting data for ${symbol} (${history.prices.length}/5 prices)`);
      return null;
    }

    const ma5 = this.calculateMA(history.prices, this.MA_FAST_PERIOD);
    const ma20 = this.calculateMA(history.prices, this.MA_SLOW_PERIOD);

    if (!ma5 || !ma20) return null;

    // Calculate previous MAs to detect crossover
    const prevPrices = history.prices.slice(0, -1);
    const prevMA5 = this.calculateMA(prevPrices, this.MA_FAST_PERIOD);
    const prevMA20 = this.calculateMA(prevPrices, this.MA_SLOW_PERIOD);

    if (!prevMA5 || !prevMA20) return null;

    // Debug: Show MA values
    const trendStrength = Math.abs(ma5 - ma20) / ma20;
    const diff = ma5 - ma20;
    
    console.log(`[${this.state.config.id}]   ${symbol}: Price=${price.toFixed(2)} MA3=${ma5.toFixed(2)} MA5=${ma20.toFixed(2)} Scans=${history.scanCount} Held=${history.tokensHeld.toFixed(2)}`);

    // FORCE TRADE: After 5 scans, trade regardless of trend strength
    const forceTrade = history.scanCount >= this.FORCE_TRADE_AFTER_SCANS;
    if (forceTrade) {
      history.scanCount = 0; // Reset counter
    }

    // TREND FOLLOWING: Buy in uptrend (MA3 > MA5), Sell in downtrend (MA3 < MA5)
    // FORCE: Always trade after 5 scans for demo visibility
    
    // BUY: In uptrend AND don't hold position (or FORCE trade)
    if ((ma5 > ma20 && history.tokensHeld === 0) || (forceTrade && history.tokensHeld === 0)) {
      if (trendStrength < this.MIN_CHANGE_PERCENT && !forceTrade) {
        console.log(`[${this.state.config.id}] ⚠️ Weak uptrend on ${symbol} (${(trendStrength * 100).toFixed(2)}%), skipping`);
        return null;
      }
      const reason = forceTrade 
        ? `FORCE TRADE after ${this.FORCE_TRADE_AFTER_SCANS} scans! MA3(${ma5.toFixed(2)}) > MA5(${ma20.toFixed(2)})`
        : `Uptrend! MA3(${ma5.toFixed(2)}) > MA5(${ma20.toFixed(2)}) - Riding the trend`;
      return {
        symbol,
        pool: this.pools.find(p => p.tokenSymbol === symbol)!,
        direction: 'BUY',
        reason,
        ma5,
        ma20,
        amount: this.TRADE_SIZES[symbol] || 0.01,
      };
    }

    // SELL: In downtrend AND hold position (or FORCE trade)
    if ((ma5 < ma20 && history.tokensHeld > 0) || (forceTrade && history.tokensHeld > 0)) {
      if (trendStrength < this.MIN_CHANGE_PERCENT && !forceTrade) {
        console.log(`[${this.state.config.id}] ⚠️ Weak downtrend on ${symbol} (${(trendStrength * 100).toFixed(2)}%), skipping`);
        return null;
      }
      const reason = forceTrade
        ? `FORCE TRADE after ${this.FORCE_TRADE_AFTER_SCANS} scans! MA3(${ma5.toFixed(2)}) < MA5(${ma20.toFixed(2)})`
        : `Downtrend! MA3(${ma5.toFixed(2)}) < MA5(${ma20.toFixed(2)}) - Exiting position`;
      return {
        symbol,
        pool: this.pools.find(p => p.tokenSymbol === symbol)!,
        direction: 'SELL',
        reason,
        ma5,
        ma20,
        amount: history.tokensHeld,
      };
    }

    return null;
  }

  /**
   * Execute trade via our AMM
   */
  private async executeTrade(op: TradeOpportunity): Promise<boolean> {
    if (!this.program) return false;

    const history = this.priceHistory.get(op.symbol)!;

    console.log(`\n[${this.state.config.id}] 📈 TRADE SIGNAL: ${op.direction} ${op.symbol}`);
    console.log(`   Reason: ${op.reason}`);
    console.log(`   MA5: ${op.ma5.toFixed(2)}, MA20: ${op.ma20.toFixed(2)}`);
    console.log(`   Amount: ${op.amount.toFixed(4)} ${op.direction === 'BUY' ? 'SOL' : op.symbol}`);

    try {
      const wallet = this.state.wallet.keypair;
      const poolPda = new PublicKey(op.pool.poolId);
      const mintA = new PublicKey(op.pool.mintA);

      const userTokenA = getAssociatedTokenAddressSync(mintA, wallet.publicKey);
      const userTokenB = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey);

      // Check balance before trading
      const solBalance = await this.connection.getBalance(wallet.publicKey);
      const minRequired = (op.amount * 1.05 + 0.005) * LAMPORTS_PER_SOL; // amount + fees + buffer
      if (solBalance < minRequired) {
        console.log(`   ⚠️ Insufficient SOL: ${(solBalance/LAMPORTS_PER_SOL).toFixed(4)} < ${(minRequired/LAMPORTS_PER_SOL).toFixed(4)} needed`);
        console.log(`   📤 Broadcasting FUND_REQUEST to Banker...`);
        messageBus.broadcast({
          from: this.state.config.id,
          to: 'BROADCAST',
          type: 'FUND_REQUEST',
          payload: {
            agentId: this.state.config.id,
            amount: 0.3,
            reason: 'Need SOL for trend trade',
            urgency: 'high'
          }
        });
        return false;
      }

      // Ensure token accounts exist
      await this.ensureTokenAccount(mintA, wallet);
      await this.ensureTokenAccount(NATIVE_MINT, wallet);

      let tx: string;
      let currentPrice: number;
      let pnl: number | undefined = undefined;

      if (op.direction === 'BUY') {
        // BUY: SOL -> Token (B_TO_A = false)
        // First wrap SOL into wSOL
        await this.wrapSol(op.amount * 1.05); // Wrap slightly more to cover fees
        
        const amountInRaw = new BN(Math.floor(op.amount * LAMPORTS_PER_SOL));
        
        tx = await (this.program.methods as any)
          .swap(amountInRaw, new BN(0), false)
          .accounts({
            user: wallet.publicKey,
            pool: poolPda,
            userTokenA,
            userTokenB,
            vaultA: new PublicKey(op.pool.vaultA),
            vaultB: new PublicKey(op.pool.vaultB),
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([wallet])
          .rpc();

        // Estimate tokens received
        currentPrice = await this.getPrice(op.pool);
        const tokensReceived = op.amount * currentPrice * 0.98; // 2% slippage
        
        // Get actual SOL spent from blockchain
        const { solSpent } = await this.calculateActualPnl(tx, 'BUY', currentPrice, tokensReceived);
        const actualSolSpent = solSpent > 0 ? solSpent : op.amount;
        
        // Update position tracking with actual cost
        const totalCost = history.tokensHeld * history.avgBuyPrice + actualSolSpent;
        history.tokensHeld += tokensReceived;
        history.avgBuyPrice = totalCost / history.tokensHeld;
        history.scanCount = 0; // Reset scan count after trade
        history.cooldownScans = 3; // Wait 3 scans before trading again (need fresh data)
        history.prices = []; // Clear old price data to force fresh analysis
        history.timestamps = [];

        console.log(`   ✅ Bought ~${tokensReceived.toFixed(4)} ${op.symbol}`);
        console.log(`   💰 Actual SOL spent: ~${actualSolSpent.toFixed(4)} SOL`);

      } else {
        // SELL: Token -> SOL (A_TO_B = true)
        const amountInRaw = new BN(Math.floor(op.amount * 10 ** op.pool.decimalsA));
        
        tx = await (this.program.methods as any)
          .swap(amountInRaw, new BN(0), true)
          .accounts({
            user: wallet.publicKey,
            pool: poolPda,
            userTokenA,
            userTokenB,
            vaultA: new PublicKey(op.pool.vaultA),
            vaultB: new PublicKey(op.pool.vaultB),
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([wallet])
          .rpc();

        currentPrice = await this.getPrice(op.pool);
        
        // Get ACTUAL P&L from blockchain
        const pnlData = await this.calculateActualPnl(
          tx, 
          'SELL', 
          history.avgBuyPrice, 
          op.amount
        );
        pnl = pnlData.actualPnl;

        history.tokensHeld = 0;
        history.avgBuyPrice = 0;
        history.scanCount = 0; // Reset scan count after trade
        history.cooldownScans = 3; // Wait 3 scans before trading again (need fresh data)
        history.prices = []; // Clear old price data to force fresh analysis
        history.timestamps = [];

        console.log(`   ✅ Sold for ~${pnlData.solReceived.toFixed(4)} SOL (actual from chain)`);
        console.log(`   💰 P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(6)} SOL`);
      }

      console.log(`   TX: ${tx.slice(0, 40)}...`);
      console.log(`   🔗 https://explorer.solana.com/tx/${tx}?cluster=devnet`);

      // Record trade
      const tradeRecord = {
        time: new Date(),
        token: op.symbol,
        action: op.direction,
        price: currentPrice,
        ma5: op.ma5,
        ma20: op.ma20,
        amount: op.amount,
        tx,
      };
      this.trades.push(tradeRecord);
      
      // Log to unified transaction logger
      // amount = token amount, solAmount = SOL amount
      const tokenAmount = op.direction === 'BUY' 
        ? op.amount * currentPrice  // SOL spent × price = tokens received
        : op.amount;                 // tokens being sold
      const solAmount = op.direction === 'BUY'
        ? op.amount                  // SOL spent
        : op.amount / currentPrice;  // tokens / price = SOL received
      
      TransactionLogger.log({
        agentId: this.state.config.id,
        agentType: this.state.config.type,
        type: 'TRADE',
        token: op.symbol,
        action: op.direction,
        amount: tokenAmount,
        price: currentPrice,
        solAmount: solAmount,
        pnl,
        txSignature: tx,
        metadata: { ma5: op.ma5, ma20: op.ma20, reason: op.reason },
      });

      // Broadcast trend signal to other agents
      messageBus.broadcast({
        from: this.state.config.id,
        to: 'broadcast',
        type: op.direction === 'BUY' ? 'PRICE_UPDATE' : 'RISK_ALERT',
        payload: {
          token: op.symbol,
          direction: op.direction,
          price: currentPrice,
          ma5: op.ma5,
          ma20: op.ma20,
          amount: op.amount,
          reason: op.reason,
          confidence: Math.abs(op.ma5 - op.ma20) / op.ma20 * 100,
        },
      });

      this.recordSuccess(
        this.createAction('SWAP', `${op.direction} ${op.symbol}: ${op.reason}`),
        op.amount,
        0.00001
      );

      return true;

    } catch (e: any) {
      console.error(`   ❌ Trade failed:`, e.message);
      this.recordFailure(
        this.createAction('SWAP', `${op.direction} ${op.symbol} failed`),
        e.message
      );
      return false;
    }
  }

  /**
   * Main strategy loop - runs every scan interval
   */
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
    
    if (!this.canTrade() || this.state.balance < 0.1) return;
    if (!this.program) await this.initProgram();

    this.lastScanTime = new Date();

    console.log(`\n[${this.state.config.id}] 📊 Trend Follower scanning...`);
    console.log(`[${this.state.config.id}] Strategy: Trend Following (Buy Uptrend / Sell Downtrend)`);

    // Scan each pool
    for (const pool of this.pools) {
      try {
        const currentPrice = await this.getPrice(pool);

        // Update history and check for signals (debug output inside)
        const opportunity = this.updatePriceHistory(pool.tokenSymbol, currentPrice);

        if (opportunity) {
          await this.executeTrade(opportunity);
        }
      } catch (e: any) {
        console.error(`[${this.state.config.id}] Error scanning ${pool.tokenSymbol}:`, e.message);
      }
    }

    // Show positions
    console.log(`\n[${this.state.config.id}] 📈 Current Positions:`);
    for (const [symbol, history] of this.priceHistory) {
      if (history.tokensHeld > 0) {
        console.log(`[${this.state.config.id}]   ${symbol}: ${history.tokensHeld.toFixed(4)} @ ${history.avgBuyPrice.toFixed(2)} avg`);
      }
    }

    // Trade summary
    const todayTrades = this.trades.filter(t => 
      t.time.toDateString() === new Date().toDateString()
    );
    
    if (todayTrades.length > 0) {
      console.log(`[${this.state.config.id}] 📊 Today's trades: ${todayTrades.length}`);
    }
  }

  async handleMessage(message: AgentMessage): Promise<void> {
    console.log(`[${this.state.config.id}] 📨 Received: ${message.type} from ${message.from}`);
    
    // React to opportunities from ArbitrageurAgent
    if (message.type === 'OPPORTUNITY' && message.payload) {
      const { token, direction, price, confidence } = message.payload;
      
      // If Arbitrageur is buying (price dip), check if it aligns with our trend analysis
      if (direction === 'BUY' && confidence > 50) {
        console.log(`[${this.state.config.id}] 🔔 Noted: ${message.from} sees BUY opportunity in ${token}`);
        console.log(`[${this.state.config.id}]    Will verify with MA analysis on next scan...`);
    
      }
    }
    
    // React to trade executions
    if (message.type === 'TRADE_EXECUTED') {
      console.log(`[${this.state.config.id}] 📊 Market activity: ${message.from} ${message.payload.action} ${message.payload.token}`);
    }
    
    // Handle fund messages
    if (message.type === 'FUND_OFFER') {
      console.log(`[${this.state.config.id}]   💰 Banker offering ${message.payload.amount} SOL - accepting!`);
      setTimeout(() => {
        this.requestFunds(message.payload.amount, message.payload.reason || 'Low balance');
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
    
    await this.requestFunds(amountNeeded, 'Low balance for trend trading');
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

  /**
   * Get trade history for reporting
   */
  getTradeHistory(): typeof this.trades {
    return this.trades;
  }
}
