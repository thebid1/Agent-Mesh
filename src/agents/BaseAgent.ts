import { Connection, Keypair, PublicKey, Transaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { WalletManager } from '../wallet/WalletManager';
import { 
  getAssociatedTokenAddressSync, 
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
  getAccount,
  NATIVE_MINT,
  createSyncNativeInstruction
} from '@solana/spl-token';
import { sendAndConfirmTransaction } from '@solana/web3.js';
import { 
  AgentConfig, 
  AgentState, 
  AgentAction, 
  AgentMessage, 
  DailyStats, 
  TotalStats,
  TransactionResult,
  PortfolioItem 
} from '../types';
import { messageBus } from '../comms/MessageBus';
import * as anchor from '@coral-xyz/anchor';
import { Program, AnchorProvider, Wallet, BN } from '@coral-xyz/anchor';
import * as fs from 'fs';
import * as path from 'path';

export abstract class BaseAgent {
  protected state: AgentState;
  protected connection: Connection;
  protected walletManager: WalletManager;
  protected isRunning: boolean = false;
  protected lastHeartbeat: Date = new Date();
  protected scanIntervalMs: number = 60000; // Default: 1 minute for faster data collection

  constructor(
    config: AgentConfig,
    connection: Connection,
    walletManager: WalletManager
  ) {
    this.connection = connection;
    this.walletManager = walletManager;

    const wallet = walletManager.getWallet(config.id);
    if (!wallet) {
      throw new Error(`Wallet not found for agent: ${config.id}`);
    }

    this.state = {
      wallet,
      config,
      status: 'INITIALIZING',
      balance: 0,
      portfolio: [],
      dailyStats: {
        tradesExecuted: 0,
        tradesFailed: 0,
        volumeTraded: 0,
        profitLoss: 0,
        gasSpent: 0,
        startTime: new Date(),
      },
      totalStats: {
        totalTrades: 0,
        totalVolume: 0,
        totalProfitLoss: 0,
        totalGasSpent: 0,
        startTime: new Date(),
      },
      lastAction: null,
    };
  }

  async initialize(): Promise<void> {
    console.log(`[${this.state.config.id}] Initializing...`);
    
    await this.updateBalance();
    
    // Register with MessageBus to receive messages
    this.registerMessageHandler();
    
    this.state.status = 'ACTIVE';
    console.log(`[${this.state.config.id}] ✓ Initialized with ${this.state.balance.toFixed(4)} SOL`);
  }

  /**
   * Register MessageBus listener
   */
  private registerMessageHandler(): void {
    // Listen for broadcast messages
    messageBus.on('broadcast', (message: AgentMessage) => {
      // Only process messages not from self
      if (message.from !== this.state.config.id) {
        this.handleMessage(message);
      }
    });

    // Listen for direct messages
    messageBus.on(`to:${this.state.config.id}`, (message: AgentMessage) => {
      this.handleMessage(message);
    });

    console.log(`[${this.state.config.id}] 📡 Registered with MessageBus`);
  }

  /**
   * Update balance and portfolio
   */
  async updateBalance(): Promise<void> {
    this.state.balance = await this.walletManager.getBalance(this.state.config.id);
    
    this.state.portfolio = [{
      mint: 'SOL',
      symbol: 'SOL',
      balance: this.state.balance,
      valueUsd: 0,
    }];
  }

  /**
   * Record a successful action
   */
  protected recordSuccess(action: AgentAction, volume: number = 0, gasUsed: number = 0): void {
    this.state.lastAction = action;
    this.state.dailyStats.tradesExecuted++;
    this.state.dailyStats.volumeTraded += volume;
    this.state.dailyStats.gasSpent += gasUsed;
    
    this.state.totalStats.totalTrades++;
    this.state.totalStats.totalVolume += volume;
    this.state.totalStats.totalGasSpent += gasUsed;

    console.log(`[${this.state.config.id}] ✓ ${action.type}: ${action.description}`);
  }

  /**
   * Record a failed action
   */
  protected recordFailure(action: AgentAction, error: string): void {
    action.status = 'FAILED';
    action.error = error;
    this.state.lastAction = action;
    this.state.dailyStats.tradesFailed++;
    
    console.log(`[${this.state.config.id}] ✗ ${action.type} failed: ${error}`);
  }

  protected canTrade(): boolean {
    if (this.state.status !== 'ACTIVE') return false;
    if (this.state.dailyStats.tradesExecuted >= this.state.config.dailyTradeLimit) {
      console.log(`[${this.state.config.id}] Daily trade limit reached`);
      return false;
    }
    return true;
  }

  /**
   * Create a new action
   */
  protected createAction(type: AgentAction['type'], description: string): AgentAction {
    return {
      type,
      timestamp: new Date(),
      description,
      status: 'PENDING',
    };
  }

  /**
   * Calculate actual P&L from blockchain transaction data
   * Returns actual SOL spent/received for accurate P&L
   */
  protected async calculateActualPnl(
    txSignature: string,
    direction: 'BUY' | 'SELL',
    buyPrice: number,
    tokenAmount: number
  ): Promise<{ actualPnl: number; solSpent: number; solReceived: number }> {
    try {
      // Wait a moment for transaction to be confirmed
      await new Promise(r => setTimeout(r, 2000));
      
      // Get transaction details with parsed data
      const tx = await this.connection.getParsedTransaction(txSignature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      
      if (!tx || !tx.meta) {
        console.log(`[${this.state.config.id}]   ⚠️ Could not fetch tx details, using estimate`);
        // Fallback to estimate
        if (direction === 'BUY') {
          const solSpent = tokenAmount / buyPrice;
          return { actualPnl: 0, solSpent, solReceived: 0 };
        } else {
          const solReceived = tokenAmount / buyPrice;
          const buyValue = tokenAmount / buyPrice;
          return { actualPnl: solReceived - buyValue, solSpent: buyValue, solReceived };
        }
      }
      
      // Get pre and post token balances
      const preBalances = tx.meta.preTokenBalances || [];
      const postBalances = tx.meta.postTokenBalances || [];
      
      // Find wSOL (wrapped SOL) changes - account index 1 is usually wSOL for our swaps
      const walletAddress = this.state.wallet.keypair.publicKey.toString();
      
      let solSpent = 0;
      let solReceived = 0;
      
      // Parse token balance changes
      for (const pre of preBalances) {
        const post = postBalances.find(p => p.accountIndex === pre.accountIndex && p.mint === pre.mint);
        if (!post) continue;
        
        const preAmount = Number(pre.uiTokenAmount?.amount || 0);
        const postAmount = Number(post.uiTokenAmount?.amount || 0);
        const change = postAmount - preAmount;
        
        // wSOL mint
        if (pre.mint === 'So11111111111111111111111111111111111111112') {
          if (change < 0) {
            solSpent = Math.abs(change) / 1e9; // wSOL is 9 decimals
          } else if (change > 0) {
            solReceived = change / 1e9;
          }
        }
      }
      
      // If token balances didn't show SOL change, use account lamport changes
      if (solSpent === 0 && solReceived === 0 && tx.meta.preBalances && tx.meta.postBalances) {
        const accountIndex = tx.transaction.message.accountKeys.findIndex(
          (acc: any) => acc.pubkey?.toString() === walletAddress || acc.toString() === walletAddress
        );
        
        if (accountIndex >= 0) {
          const preLamports = tx.meta.preBalances[accountIndex];
          const postLamports = tx.meta.postBalances[accountIndex];
          const lamportChange = postLamports - preLamports;
          
          // Account for transaction fee (~0.000005 SOL)
          const fee = tx.meta.fee || 5000;
          const adjustedChange = lamportChange + fee;
          
          if (adjustedChange < 0) {
            solSpent = Math.abs(adjustedChange) / 1e9;
          } else if (adjustedChange > 0) {
            solReceived = adjustedChange / 1e9;
          }
        }
      }
      
      // Calculate P&L for SELL trades
      let actualPnl = 0;
      if (direction === 'SELL' && buyPrice > 0) {
        const buyValue = tokenAmount / buyPrice;
        actualPnl = solReceived - buyValue;
      }
      
      return { actualPnl, solSpent, solReceived };
      
    } catch (error: any) {
      console.log(`[${this.state.config.id}]   ⚠️ P&L calc error: ${error.message.slice(0, 50)}`);
      // Fallback to estimate
      if (direction === 'BUY') {
        const solSpent = tokenAmount / buyPrice;
        return { actualPnl: 0, solSpent, solReceived: 0 };
      } else {
        const solReceived = tokenAmount / buyPrice;
        const buyValue = tokenAmount / buyPrice;
        return { actualPnl: solReceived - buyValue, solSpent: buyValue, solReceived };
      }
    }
  }

  /**
   * Ensure token account exists (create if needed)
   */
  protected async ensureTokenAccount(mint: PublicKey, wallet: Keypair): Promise<void> {
    try {
      const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey);
      
      // Account exists?
      try {
        await this.connection.getTokenAccountBalance(ata);
        return; // Account exists
      } catch {
        // Account doesn't exist, create it
      }
      
      const tx = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(
          wallet.publicKey,
          ata,
          wallet.publicKey,
          mint
        )
      );
      
      await sendAndConfirmTransaction(this.connection, tx, [wallet]);
      console.log(`[${this.state.config.id}] ✓ Created token account for ${mint.toString().slice(0, 8)}...`);
    } catch (e) {
      // Ignore errors - account might already exist
    }
  }

  /**
   * Get token balance for any token mint
   */
  protected async getTokenBalance(mint: PublicKey): Promise<number> {
    try {
      const wallet = this.state.wallet.keypair;
      const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey);
      const balance = await this.connection.getTokenAccountBalance(ata);
      return Number(balance.value.amount) / (10 ** (balance.value.decimals || 6));
    } catch {
      return 0;
    }
  }

  /**
   * Liquidate tokens for SOL when balance is low
   * Sells a percentage of token holdings to get SOL
   * @returns Amount of SOL gained from liquidation
   */
  protected async liquidateTokensForSol(targetSolAmount: number = 1.0): Promise<number> {
    const MIN_SOL_THRESHOLD = 0.1; // Need at least 0.1 SOL for fees
    
    // Check current SOL balance
    const currentSol = await this.walletManager.getBalance(this.state.config.id);
    if (currentSol >= targetSolAmount) {
      return 0; // Already have enough SOL
    }
    
    console.log(`\n[${this.state.config.id}] 💸 LOW SOL BALANCE: ${currentSol.toFixed(4)} SOL`);
    console.log(`[${this.state.config.id}]    Liquidating tokens to reach ${targetSolAmount} SOL...`);
    
    // Load pool configs
    const poolPath = path.resolve(process.cwd(), 'pool-configs.json');
    if (!fs.existsSync(poolPath)) {
      console.log(`[${this.state.config.id}]    ⚠️ No pool configs found`);
      return 0;
    }
    
    const pools: Record<string, any> = JSON.parse(fs.readFileSync(poolPath, 'utf-8'));
    const wallet = this.state.wallet.keypair;
    
    // Initialize AMM program
    let program: Program<any> | null = null;
    try {
      const anchorWallet = new Wallet(wallet);
      const provider = new AnchorProvider(this.connection, anchorWallet, { commitment: 'confirmed' });
      const idl = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'anchor-amm/app/idl.json'), 'utf-8'));
      program = new Program(idl, provider);
    } catch (e: any) {
      console.log(`[${this.state.config.id}]    ⚠️ Could not initialize AMM: ${e.message}`);
      return 0;
    }
    
    let totalSolGained = 0;
    const tokensToLiquidate = ['AUSDC', 'ABTC', 'AETH', 'ASOL'];
    const SELL_PERCENTAGE = 0.30; // Sell 30% of holdings each time
    const MAX_LIQUIDATION_ATTEMPTS = 5;
    
    for (let attempt = 0; attempt < MAX_LIQUIDATION_ATTEMPTS; attempt++) {
      // Target reached?
      const solBalance = await this.walletManager.getBalance(this.state.config.id);
      if (solBalance >= targetSolAmount) {
        console.log(`[${this.state.config.id}]    ✅ Reached target SOL balance: ${solBalance.toFixed(4)} SOL`);
        break;
      }
      
      // Need minimum SOL for transaction fees
      if (solBalance < MIN_SOL_THRESHOLD) {
        console.log(`[${this.state.config.id}]    ⚠️ Insufficient SOL for fees (${solBalance.toFixed(4)} < ${MIN_SOL_THRESHOLD})`);
        break;
      }
      
      // Find token with highest balance
      let bestToken: { symbol: string; balance: number; pool: any } | null = null;
      
      for (const symbol of tokensToLiquidate) {
        const pool = pools[symbol];
        if (!pool) continue;
        
        const mint = new PublicKey(pool.mintA);
        const balance = await this.getTokenBalance(mint);
        
        if (balance > 0.001) { // Minimum meaningful amount
          if (!bestToken || balance > bestToken.balance) {
            bestToken = { symbol, balance, pool };
          }
        }
      }
      
      if (!bestToken) {
        console.log(`[${this.state.config.id}]    ⚠️ No tokens available to liquidate`);
        break;
      }
      
      // Calculate amount to sell (30% of holdings)
      const sellAmount = bestToken.balance * SELL_PERCENTAGE;
      
      console.log(`[${this.state.config.id}]    Selling ${sellAmount.toFixed(4)} ${bestToken.symbol} (${(SELL_PERCENTAGE*100).toFixed(0)}% of ${bestToken.balance.toFixed(4)})`);
      
      try {
        const poolPda = new PublicKey(bestToken.pool.poolId);
        const mintA = new PublicKey(bestToken.pool.mintA);
        const userTokenA = getAssociatedTokenAddressSync(mintA, wallet.publicKey);
        const userTokenB = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey);
        
        // Ensure accounts exist
        await this.ensureTokenAccount(mintA, wallet);
        await this.ensureTokenAccount(NATIVE_MINT, wallet);
        
        // Execute swap: Token -> SOL (A_TO_B = true)
        const amountInRaw = new BN(Math.floor(sellAmount * 10 ** bestToken.pool.decimalsA));
        
        const tx = await (program.methods as any)
          .swap(amountInRaw, new BN(0), true)  // A_TO_B = true (token to SOL)
          .accounts({
            user: wallet.publicKey,
            pool: poolPda,
            userTokenA,
            userTokenB,
            vaultA: new PublicKey(bestToken.pool.vaultA),
            vaultB: new PublicKey(bestToken.pool.vaultB),
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([wallet])
          .rpc();
        
        console.log(`[${this.state.config.id}]    ✅ Sold ${sellAmount.toFixed(4)} ${bestToken.symbol}`);
        console.log(`[${this.state.config.id}]    TX: ${tx.slice(0, 40)}...`);
        
        // Estimate SOL gained (will vary with price)
        totalSolGained += sellAmount * 0.001; // Rough estimate
        
        // Rate limit
        await new Promise(r => setTimeout(r, 2000));
        
      } catch (e: any) {
        console.log(`[${this.state.config.id}]    ❌ Failed to sell ${bestToken.symbol}: ${e.message.slice(0, 50)}`);
        continue;
      }
    }
    
    // Update balance
    await this.updateBalance();
    const finalSol = await this.walletManager.getBalance(this.state.config.id);
    console.log(`[${this.state.config.id}]    Final SOL balance: ${finalSol.toFixed(4)} SOL`);
    
    return finalSol - currentSol;
  }

  /**
   * Main strategy loop - implemented by subclasses
   */
  abstract executeStrategy(): Promise<void>;

  /**
   * Run the agent
   */
  async run(): Promise<void> {
    this.isRunning = true;
    
    while (this.isRunning) {
      try {
        if (this.state.status === 'ACTIVE') {
          await this.executeStrategy();
        }
        
        this.lastHeartbeat = new Date();
        
        // Configurable scan interval
        await new Promise(resolve => setTimeout(resolve, this.scanIntervalMs));
      } catch (error: any) {
        console.error(`[${this.state.config.id}] Error in main loop:`, error.message);
        this.state.status = 'ERROR';
        
        await new Promise(resolve => setTimeout(resolve, 60000));
        this.state.status = 'ACTIVE';
      }
    }
  }

  /**
   * Stop the agent
   */
  stop(): void {
    this.isRunning = false;
    this.state.status = 'PAUSED';
    console.log(`[${this.state.config.id}] Stopped`);
  }

  /**
   * Pause the agent
   */
  pause(): void {
    this.state.status = 'PAUSED';
    console.log(`[${this.state.config.id}] Paused`);
  }

  /**
   * Resume the agent
   */
  resume(): void {
    this.state.status = 'ACTIVE';
    console.log(`[${this.state.config.id}] Resumed`);
  }

  /**
   * Get agent status
   */
  getStatus(): AgentState {
    return { ...this.state };
  }

  /**
   * Handle incoming message
   */
  abstract handleMessage(message: AgentMessage): Promise<void>;

  /**
   * Reset daily stats
   */
  resetDailyStats(): void {
    this.state.dailyStats = {
      tradesExecuted: 0,
      tradesFailed: 0,
      volumeTraded: 0,
      profitLoss: 0,
      gasSpent: 0,
      startTime: new Date(),
    };
  }
}
