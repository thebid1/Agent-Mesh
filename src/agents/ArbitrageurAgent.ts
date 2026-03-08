/**
 * Arbitrageur Agent - Price Momentum Trading
 * 
 * Tracks price history and trades when prices move:
 * - Price DROPS → BUY (expect bounce)
 * - Price RISES → SELL (expect pullback)
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

/**
 * Find the Banker agent ID from agents.config.json
 */
function findBankerAgentId(): string | null {
  try {
    const configPath = path.resolve(process.cwd(), 'agents.config.json');
    if (!fs.existsSync(configPath)) return null;
    
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const banker = config.agents?.find((a: any) => a.type === 'BANKER');
    return banker?.id || null;
  } catch {
    return null;
  }
}

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
  prices: number[];     // Last N prices
  timestamps: Date[];
  tokensHeld: number;   // Current position
  avgBuyPrice: number;  // Average buy price
}

interface TradeOpportunity {
  symbol: string;
  pool: PoolConfig;
  direction: 'BUY' | 'SELL';
  reason: string;
  priceChange: number;
  amount: number;
}

export class ArbitrageurAgent extends BaseAgent {
  private readonly PRICE_HISTORY_SIZE = 5;
  private readonly MIN_CHANGE_PERCENT = 0.002;  // 0.2% minimum change
  private readonly MAX_POSITION_SOL = 0.3;      // Max position per token
  private readonly SCAN_INTERVAL_MS = 60000;    // 1 minute between scans (faster for demo)
  private readonly CONSECUTIVE_BUY_THRESHOLD = 5; // AUTO-SELL after 5 consecutive buys
  private readonly LOW_BALANCE_THRESHOLD = 0.2;  // Request funds below 0.2 SOL
  private readonly FUND_REQUEST_COOLDOWN = 60000; // 1 min between requests
  
  // Pool-specific trade sizes to avoid MathOverflow
  // Pool-specific trade sizes (u64 overflow protection)
  private readonly TRADE_SIZES: Record<string, number> = {
    'AUSDC': 0.02,   // 760 USDC - safe
    'ABTC': 0.05,    // 20 BTC - safe  
    'AETH': 0.005,   // 10 ETH - safe (was causing overflow at 0.05)
    'ASOL': 0.02,    // 0.4 SOL - safe
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
    amount: number;
    pnl?: number;
    tx: string;
  }> = [];
  
  // P&L Tracking
  private consecutiveBuyCount = 0;
  private totalPnL = 0;
  private sessionStartValue = 0;
  private initialBalance = 0;

  private lastFundRequest: number = 0;
  private pendingFundRequest: boolean = false;
  private debtToBanker: number = 0;

  constructor(
    config: AgentConfig,
    connection: Connection,
    walletManager: WalletManager
  ) {
    super(config, connection, walletManager);
    this.scanIntervalMs = this.SCAN_INTERVAL_MS; // 5 minute scans
    this.loadPools();
    this.initProgram();
    this.initPriceHistory();
    
    // Subscribe to fund-related messages
    messageBus.subscribe(config.id, ['FUND_OFFER', 'FUNDS_SENT', 'FUND_REJECTED']);
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
      });
    }
  }

  /**
   * Show recent trades from log
   */
  static showRecentTrades(): void {
    TransactionLogger.printDashboard();
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
   * Log trade to persistent file
   */
  /**
   * Get current price for a pool
   */
  private async getPrice(pool: PoolConfig): Promise<number> {
    const [tokenBal, solBal] = await Promise.all([
      this.connection.getTokenAccountBalance(new PublicKey(pool.vaultA)),
      this.connection.getTokenAccountBalance(new PublicKey(pool.vaultB)),
    ]);

    const tokenReserve = Number(tokenBal.value.amount) / 10 ** pool.decimalsA;
    const solReserve = Number(solBal.value.amount) / LAMPORTS_PER_SOL;

    return tokenReserve / solReserve;  // tokens per SOL
  }

  /**
   * Update price history and check for signals
   */
  private updatePriceHistory(symbol: string, price: number): TradeOpportunity | null {
    const history = this.priceHistory.get(symbol)!;
    
    // Add new price
    history.prices.push(price);
    history.timestamps.push(new Date());
    
    // Keep only last N prices
    if (history.prices.length > this.PRICE_HISTORY_SIZE) {
      history.prices.shift();
      history.timestamps.shift();
    }

    // Need at least 2 prices to compare
    if (history.prices.length < 2) return null;

    const prevPrice = history.prices[history.prices.length - 2];
    const priceChange = (price - prevPrice) / prevPrice;

    // CHECK BUY SIGNAL: Price dropped significantly
    if (priceChange < -this.MIN_CHANGE_PERCENT && history.tokensHeld === 0) {
      const tradeSize = this.TRADE_SIZES[symbol] || 0.01;
      return {
        symbol,
        pool: this.pools.find(p => p.tokenSymbol === symbol)!,
        direction: 'BUY',
        reason: `Price dropped ${(Math.abs(priceChange) * 100).toFixed(2)}% (buy the dip)`,
        priceChange,
        amount: tradeSize,
      };
    }

    // SELL signal: price rose and we hold position
    if (priceChange > this.MIN_CHANGE_PERCENT && history.tokensHeld > 0) {
      return {
        symbol,
        pool: this.pools.find(p => p.tokenSymbol === symbol)!,
        direction: 'SELL',
        reason: `Price rose ${(priceChange * 100).toFixed(2)}% (take profit)`,
        priceChange,
        amount: history.tokensHeld,
      };
    }

    return null;
  }

  /**
   * Execute trade
   */
  private async executeTrade(op: TradeOpportunity): Promise<boolean> {
    if (!this.program) return false;

    const history = this.priceHistory.get(op.symbol)!;

    console.log(`\n[${this.state.config.id}] 📈 TRADE SIGNAL: ${op.direction} ${op.symbol}`);
    console.log(`   Reason: ${op.reason}`);
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
            reason: 'Need SOL for arbitrage trade',
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

      if (op.direction === 'BUY') {
        // BUY: SOL -> Token (B_TO_A)
        // First wrap SOL into wSOL
        await this.wrapSol(op.amount * 1.05); // Wrap slightly more to cover fees
        
        const amountInRaw = new BN(Math.floor(op.amount * LAMPORTS_PER_SOL));
        
        tx = await (this.program.methods as any)
          .swap(amountInRaw, new BN(0), false)  // B_TO_A = false
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
        const tokensReceived = op.amount * currentPrice * 0.98;  // 2% slippage
        
        // Get actual SOL spent from blockchain
        const { solSpent } = await this.calculateActualPnl(tx, 'BUY', currentPrice, tokensReceived);
        
        // Use actual cost from chain
        const actualBuyPrice = solSpent > 0 ? tokensReceived / solSpent : currentPrice;
        
        history.tokensHeld = tokensReceived;
        history.avgBuyPrice = actualBuyPrice;

        console.log(`   ✅ Bought ~${tokensReceived.toFixed(4)} ${op.symbol}`);
        console.log(`   💰 Actual SOL spent: ~${solSpent.toFixed(4)} SOL`);

      } else {
        // SELL: Token -> SOL (A_TO_B)
        const amountInRaw = new BN(Math.floor(op.amount * 10 ** op.pool.decimalsA));
        
        tx = await (this.program.methods as any)
          .swap(amountInRaw, new BN(0), true)  // A_TO_B = true
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
        const { actualPnl, solReceived } = await this.calculateActualPnl(
          tx, 
          'SELL', 
          history.avgBuyPrice, 
          op.amount
        );
        
        const pnl = actualPnl;

        // Partial sell support: subtract sold amount, don't zero out
        history.tokensHeld -= op.amount;
        if (history.tokensHeld <= 0.0001) { // Fully sold (with small buffer)
          history.tokensHeld = 0;
          history.avgBuyPrice = 0;
        }

        console.log(`   ✅ Sold for ~${solReceived.toFixed(4)} SOL (actual from chain)`);
        console.log(`   💰 P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(6)} SOL`);
        console.log(`   📊 Remaining: ${history.tokensHeld.toFixed(4)} tokens`);
      }

      console.log(`   TX: ${tx.slice(0, 40)}...`);
      console.log(`   🔗 https://explorer.solana.com/tx/${tx}?cluster=devnet`);

      // Calculate P&L for SELL trades
      let tradePnL: number | undefined;
      if (op.direction === 'SELL') {
        tradePnL = (currentPrice - history.avgBuyPrice) * op.amount;
        this.totalPnL += tradePnL;
      }

      // Record trade
      const tradeRecord = {
        time: new Date(),
        token: op.symbol,
        action: op.direction,
        price: currentPrice,
        amount: op.amount,
        pnl: tradePnL,
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
        pnl: tradePnL,
        txSignature: tx,
        metadata: { reason: op.reason },
      });

      // Track consecutive buys and P&L
      if (op.direction === 'BUY') {
        this.consecutiveBuyCount++;
        console.log(`   📊 Consecutive buys: ${this.consecutiveBuyCount}/${this.CONSECUTIVE_BUY_THRESHOLD}`);
        
        // Broadcast opportunity to other agents
        messageBus.broadcast({
          from: this.state.config.id,
          to: 'broadcast',
          type: 'OPPORTUNITY',
          payload: {
            token: op.symbol,
            direction: op.direction,
            price: currentPrice,
            amount: op.amount,
            reason: op.reason,
            confidence: Math.abs(op.priceChange) * 100,
          },
        });
        
        // Take profits after consecutive buys
        if (this.consecutiveBuyCount >= this.CONSECUTIVE_BUY_THRESHOLD) {
          console.log(`   🎯 Profit-taking threshold reached!`);
          await this.takeProfits();
          this.consecutiveBuyCount = 0; // Reset counter
        }
      } else {
        // SELL trade - log realized P&L
        if (tradePnL !== undefined) {
          console.log(`   💰 Realized P&L: ${tradePnL >= 0 ? '+' : ''}${tradePnL.toFixed(6)} SOL`);
          console.log(`   💰 Total P&L: ${this.totalPnL >= 0 ? '+' : ''}${this.totalPnL.toFixed(6)} SOL`);
        }
        this.consecutiveBuyCount = Math.max(0, this.consecutiveBuyCount - 2); // Reduce but don't reset
      }
      
      // Broadcast trade execution
      messageBus.broadcast({
        from: this.state.config.id,
        to: 'broadcast',
        type: 'TRADE_EXECUTED',
        payload: {
          token: op.symbol,
          action: op.direction,
          amount: op.amount,
          price: currentPrice,
          pnl: tradePnL,
          tx: tx.slice(0, 20) + '...',
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
   * Agent intelligently decides optimal sell percentage based on market conditions
   * Factors: P&L, portfolio concentration, consecutive buys
   */
  private calculateOptimalSellPercentage(
    position: { unrealizedPnL: number; solValue: number; history: PriceHistory; currentPrice: number },
    portfolioPercentage: number
  ): number {
    let sellPercentage = 0.5; // Default: sell 50%
    const reasons: string[] = [];
    
    // Factor 1: P&L - Higher profits = sell more to lock in gains
    const pnlPercent = (position.unrealizedPnL / position.solValue) * 100;
    if (pnlPercent > 10) {
      sellPercentage += 0.3; // +30% if very profitable (>10%)
      reasons.push(`High profit +${pnlPercent.toFixed(1)}%`);
    } else if (pnlPercent > 5) {
      sellPercentage += 0.15; // +15% if profitable (>5%)
      reasons.push(`Good profit +${pnlPercent.toFixed(1)}%`);
    } else if (pnlPercent < -5) {
      sellPercentage -= 0.2; // -20% if losing (hold for recovery)
      reasons.push(`Loss ${pnlPercent.toFixed(1)}% (hold)`);
    }
    
    // Factor 2: Portfolio concentration - Large position = sell more to reduce risk
    if (portfolioPercentage > 50) {
      sellPercentage += 0.15; // +15% if >50% of portfolio
      reasons.push(`Large position ${portfolioPercentage.toFixed(1)}%`);
    } else if (portfolioPercentage > 30) {
      sellPercentage += 0.05; // +5% if >30% of portfolio
      reasons.push(`Med position ${portfolioPercentage.toFixed(1)}%`);
    }
    
    // Factor 3: Consecutive buys - More buys = more aggressive selling
    if (this.consecutiveBuyCount >= 7) {
      sellPercentage += 0.15; // +15% if 7+ consecutive buys
      reasons.push(`High buy streak ${this.consecutiveBuyCount}`);
    } else if (this.consecutiveBuyCount >= 5) {
      sellPercentage += 0.05; // +5% if 5-6 consecutive buys
      reasons.push(`Buy streak ${this.consecutiveBuyCount}`);
    }
    
    // Bound between 20-90%
    sellPercentage = Math.max(0.2, Math.min(0.9, sellPercentage));
    
    // Log the decision
    console.log(`[${this.state.config.id}]   🤔 Decision factors: ${reasons.join(', ') || 'Default 50%'}`);
    console.log(`[${this.state.config.id}]   📊 Calculated: ${(sellPercentage * 100).toFixed(0)}%`);
    
    return sellPercentage;
  }

  /**
   * Take profits - sell the most profitable position after 10 consecutive buys
   */
  private async takeProfits(): Promise<void> {
    console.log(`\n[${this.state.config.id}] 🎯 AUTO-SELL AFTER ${this.CONSECUTIVE_BUY_THRESHOLD} CONSECUTIVE BUYS`);
    
    // Find all positions with tokens held
    const positions: Array<{ symbol: string; history: PriceHistory; currentPrice: number; unrealizedPnL: number; solValue: number }> = [];
    
    for (const [symbol, history] of this.priceHistory) {
      if (history.tokensHeld > 0) {
        try {
          const pool = this.pools.find(p => p.tokenSymbol === symbol);
          if (pool) {
            const currentPrice = await this.getPrice(pool);
            // CORRECT unrealized P&L calculation
            const currentValue = history.tokensHeld / currentPrice;       // Current SOL value
            const buyValue = history.tokensHeld / history.avgBuyPrice;    // Original SOL cost
            const unrealizedPnL = currentValue - buyValue;                // P&L in SOL
            const solValue = currentValue;                                // SOL value of position
            positions.push({ symbol, history, currentPrice, unrealizedPnL, solValue });
          }
        } catch (e) {
          // Skip if can't get price
        }
      }
    }
    
    if (positions.length === 0) {
      console.log(`[${this.state.config.id}]   ⚠️ No positions to sell`);
      return;
    }
    
    // Sort by SOL value (DESCENDING) - sell the LARGEST holding first
    positions.sort((a, b) => b.solValue - a.solValue);
    
    console.log(`[${this.state.config.id}]   📊 Current positions (sorted by SOL value):`);
    for (const pos of positions) {
      const emoji = pos.unrealizedPnL >= 0 ? '🟢' : '🔴';
      const isLargest = pos === positions[0] ? ' 👈 SELLING' : '';
      const percentage = (pos.solValue / this.state.balance) * 100;
      console.log(`[${this.state.config.id}]     ${emoji} ${pos.symbol}: ${pos.history.tokensHeld.toFixed(4)} tokens (${pos.solValue.toFixed(4)} SOL, ${percentage.toFixed(1)}% of portfolio) | P&L: ${pos.unrealizedPnL >= 0 ? '+' : ''}${pos.unrealizedPnL.toFixed(6)} SOL${isLargest}`);
    }
    
    // Sell the LARGEST holding (highest SOL value)
    const largestPosition = positions[0];
    const pool = this.pools.find(p => p.tokenSymbol === largestPosition.symbol)!;
    const portfolioPct = (largestPosition.solValue / this.state.balance) * 100;
    
    // AGENT DECIDES: Calculate optimal sell percentage based on conditions
    const sellPercentage = this.calculateOptimalSellPercentage(largestPosition, portfolioPct);
    
    const tokensToSell = largestPosition.history.tokensHeld * sellPercentage;
    const solToReceive = tokensToSell * largestPosition.currentPrice;
    
    console.log(`[${this.state.config.id}]   🤖 AGENT DECISION: Sell ${(sellPercentage * 100).toFixed(0)}% of ${largestPosition.symbol}`);
    console.log(`[${this.state.config.id}]      Tokens: ${tokensToSell.toFixed(4)} / ${largestPosition.history.tokensHeld.toFixed(4)}`);
    console.log(`[${this.state.config.id}]      Estimated SOL: ~${solToReceive.toFixed(4)} SOL`);
    
    const sellOp: TradeOpportunity = {
      symbol: largestPosition.symbol,
      pool: pool,
      direction: 'SELL',
      reason: `Auto-sell ${(sellPercentage * 100).toFixed(0)}%: Agent decided based on P&L ${largestPosition.unrealizedPnL >= 0 ? '+' : ''}${largestPosition.unrealizedPnL.toFixed(4)}`,
      priceChange: 0,
      amount: tokensToSell,
    };
    
    await this.executeTrade(sellOp);
  }

  /**
   * Main strategy loop
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
    
    // Auto-repay Banker when profitable
    if (this.debtToBanker > 0 && this.totalPnL > 0.05) {
      await this.repayBanker();
    }
    
    if (!this.canTrade() || this.state.balance < 0.1) return;
    if (!this.program) await this.initProgram();

    this.lastScanTime = new Date();

    try {
      console.log(`\n[${this.state.config.id}] 🔍 Scanning ${this.pools.length} pools...`);
      console.log(`[${this.state.config.id}] Balance: ${this.state.balance.toFixed(4)} SOL`);

      const opportunities: TradeOpportunity[] = [];

      // Check each pool for price changes
      for (const pool of this.pools) {
        try {
          const price = await this.getPrice(pool);
          const op = this.updatePriceHistory(pool.tokenSymbol, price);
          
          if (op) {
            opportunities.push(op);
          }

          // Print price history
          const history = this.priceHistory.get(pool.tokenSymbol)!;
          const change = history.prices.length >= 2 
            ? ((price - history.prices[0]) / history.prices[0] * 100).toFixed(2)
            : '0.00';
          const position = history.tokensHeld > 0 ? ` [HOLD ${history.tokensHeld.toFixed(2)}]` : '';
          
          console.log(`[${this.state.config.id}]   ${pool.tokenSymbol}: ${price.toFixed(4)} (${change}%)${position}`);

        } catch (e) {
          // Skip failed pools
        }
      }

      // Execute best opportunity (if any)
      if (opportunities.length > 0) {
        // Sort by price change magnitude
        opportunities.sort((a, b) => Math.abs(b.priceChange) - Math.abs(a.priceChange));
        
        console.log(`[${this.state.config.id}] 🎯 ${opportunities.length} trade signals found`);
        
        for (const op of opportunities.slice(0, 2)) {  // Max 2 trades per scan
          await this.executeTrade(op);
          await new Promise(r => setTimeout(r, 2000));  // Wait between trades
        }
      } else {
        console.log(`[${this.state.config.id}] No trade signals`);
      }

      // Print stats
      if (this.trades.length > 0) {
        const recent = this.trades.slice(-5);
        console.log(`\n[${this.state.config.id}] 📊 Recent trades:`);
        for (const t of recent) {
          const pnlStr = t.pnl !== undefined ? ` | P&L: ${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(4)}` : '';
          console.log(`[${this.state.config.id}]   ${t.action} ${t.token} @ ${t.price.toFixed(4)}${pnlStr}`);
        }
      }
      
      // Print P&L summary
      this.printPnLSummary();

    } catch (e: any) {
      console.error(`[${this.state.config.id}] Error:`, e.message);
    }
  }
  
  /**
   * Print P&L summary
   */
  private async printPnLSummary(): Promise<void> {
    const positions = Array.from(this.priceHistory.entries())
      .filter(([_, h]) => h.tokensHeld > 0);
    
    let unrealizedPnL = 0;
    for (const [symbol, history] of positions) {
      try {
        const pool = this.pools.find(p => p.tokenSymbol === symbol);
        if (pool) {
          const currentPrice = await this.getPrice(pool);
          unrealizedPnL += (currentPrice - history.avgBuyPrice) * history.tokensHeld;
        }
      } catch (e) {
        // Skip
      }
    }
    
    const totalTrades = this.trades.length;
    const buyTrades = this.trades.filter(t => t.action === 'BUY').length;
    const sellTrades = this.trades.filter(t => t.action === 'SELL').length;
    
    console.log(`\n[${this.state.config.id}] 💰 P&L SUMMARY`);
    console.log(`[${this.state.config.id}]   Total Trades: ${totalTrades} (${buyTrades} buys, ${sellTrades} sells)`);
    console.log(`[${this.state.config.id}]   Consecutive Buys: ${this.consecutiveBuyCount}/${this.CONSECUTIVE_BUY_THRESHOLD}`);
    console.log(`[${this.state.config.id}]   Realized P&L: ${this.totalPnL >= 0 ? '+' : ''}${this.totalPnL.toFixed(6)} SOL`);
    console.log(`[${this.state.config.id}]   Unrealized P&L: ${unrealizedPnL >= 0 ? '+' : ''}${unrealizedPnL.toFixed(6)} SOL`);
    console.log(`[${this.state.config.id}]   Total P&L: ${(this.totalPnL + unrealizedPnL) >= 0 ? '+' : ''}${(this.totalPnL + unrealizedPnL).toFixed(6)} SOL`);
    
    if (positions.length > 0) {
      console.log(`[${this.state.config.id}]   Open Positions:`);
      for (const [symbol, history] of positions) {
        console.log(`[${this.state.config.id}]     ${symbol}: ${history.tokensHeld.toFixed(4)} tokens @ ${history.avgBuyPrice.toFixed(4)} avg`);
      }
    }
  }

  async handleMessage(message: AgentMessage): Promise<void> {
    console.log(`[${this.state.config.id}] 📨 Received: ${message.type} from ${message.from}`);
    
    if (message.type === 'RISK_ALERT' && message.payload.severity === 'HIGH') {
      this.pause();
    }
    
    if (message.type === 'FUND_OFFER') {
      console.log(`[${this.state.config.id}]   💰 Banker offering ${message.payload.amount} SOL - accepting!`);
      // Automatically accept the offer by requesting (with small delay)
      setTimeout(() => {
        this.requestFunds(message.payload.amount, message.payload.reason || 'Low balance');
      }, 100);
    }
    
    if (message.type === 'FUNDS_SENT') {
      console.log(`[${this.state.config.id}]   ✅ Received ${message.payload.amount} SOL from Banker!`);
      this.pendingFundRequest = false;
      this.debtToBanker = message.payload.remainingDebt || 0;
      await this.updateBalance(); // Refresh balance
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
    
    // Calculate amount needed
    const amountNeeded = Math.min(0.5, 0.5 - this.state.balance);
    if (amountNeeded < 0.05) return;
    
    await this.requestFunds(amountNeeded, 'Low balance for trading');
  }
  
  private async requestFunds(amount: number, reason: string): Promise<void> {
    console.log(`\n[${this.state.config.id}] 📥 REQUESTING FUNDS from Banker`);
    console.log(`[${this.state.config.id}]   Amount: ${amount.toFixed(4)} SOL`);
    console.log(`[${this.state.config.id}]   Reason: ${reason}`);
    
    messageBus.broadcast({
      from: this.state.config.id,
      to: 'broadcast', // Banker will pick this up
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
  
  private async repayBanker(): Promise<void> {
    if (this.debtToBanker <= 0) return;
    
    const repayAmount = Math.min(this.debtToBanker, this.totalPnL * 0.5); // Repay 50% of profits
    if (repayAmount < 0.05) return;
    
    // Dynamically find the Banker agent ID
    const bankerId = findBankerAgentId();
    if (!bankerId) {
      console.log(`[${this.state.config.id}]   ⚠️  Could not find Banker agent ID, skipping repayment`);
      return;
    }
    
    console.log(`\n[${this.state.config.id}] 💸 Repaying Banker: ${repayAmount.toFixed(4)} SOL`);
    
    try {
      const result = await this.walletManager.transfer(
        this.state.config.id,
        bankerId,
        repayAmount
      );
      
      if (result.success) {
        this.debtToBanker -= repayAmount;
        console.log(`[${this.state.config.id}]   ✅ Repaid ${repayAmount.toFixed(4)} SOL`);
        console.log(`[${this.state.config.id}]   Remaining debt: ${this.debtToBanker.toFixed(4)} SOL`);
        
        messageBus.broadcast({
          from: this.state.config.id,
          to: bankerId,
          type: 'FUNDS_REPAYMENT',
          payload: {
            token: 'SOL',
            amount: repayAmount,
            remainingDebt: this.debtToBanker,
          },
        });
      }
    } catch (e: any) {
      console.error(`[${this.state.config.id}]   ❌ Repayment failed:`, e.message);
    }
  }

  /**
   * Get trading stats with P&L
   */
  getStats() {
    const positions = Array.from(this.priceHistory.entries())
      .filter(([_, h]) => h.tokensHeld > 0);
    
    return {
      totalTrades: this.trades.length,
      buyTrades: this.trades.filter(t => t.action === 'BUY').length,
      sellTrades: this.trades.filter(t => t.action === 'SELL').length,
      consecutiveBuyCount: this.consecutiveBuyCount,
      realizedPnL: this.totalPnL,
      openPositions: positions.map(([sym, h]) => ({ 
        token: sym, 
        amount: h.tokensHeld,
        avgBuyPrice: h.avgBuyPrice 
      })),
    };
  }
}
