/**
 * Banker Agent - Central Liquidity Provider for the Swarm
 * 
 * Role:
 * - Provides SOL and tokens to other agents when their balance is low
 * - Monitors agent balances and responds to FUND_REQUEST messages
 * - Tracks loans and repayments (internal accounting)
 * - Ensures swarm can continue operating even when individual agents run low
 * 
 * Economic Model:
 * - Agents request funds when balance < threshold
 * - Banker evaluates request (trust score, current balance, purpose)
 * - Transfers SOL or tokens directly to requesting agent
 * - Tracks as internal debt (no interest for now - just cooperation)
 */

import { Connection, PublicKey, LAMPORTS_PER_SOL, Transaction, SystemProgram, sendAndConfirmTransaction } from '@solana/web3.js';
import { WalletManager } from '../wallet/WalletManager';
import { BaseAgent } from './BaseAgent';
import { AgentConfig, AgentMessage } from '../types';
import { messageBus } from '../comms/MessageBus';
import { TransactionLogger } from '../utils/TransactionLogger';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createTransferInstruction,
  getAccount,
  createAssociatedTokenAccountInstruction,
} from '@solana/spl-token';
import * as fs from 'fs';
import * as path from 'path';

interface FundRequest {
  id: string;
  requesterId: string;
  token: string;      // 'SOL' or token mint
  amount: number;
  reason: string;
  urgency: 'LOW' | 'MEDIUM' | 'HIGH';
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'FULFILLED';
  requestedAt: Date;
  fulfilledAt?: Date;
  txSignature?: string;
}

interface AgentCredit {
  agentId: string;
  totalRequested: number;
  totalReceived: number;
  totalRepaid: number;
  currentDebt: number;
  requestCount: number;
  trustScore: number; // 0-100, increases with repayments
  lastRequestAt?: Date;
}

interface TokenConfig {
  symbol: string;
  mint: string;
  decimals: number;
}

export class BankerAgent extends BaseAgent {
  private readonly SCAN_INTERVAL_MS = 15000; // 15 seconds
  private readonly MIN_BANKER_RESERVE = 1.0; // Keep 1 SOL minimum
  private readonly MAX_SINGLE_TRANSFER = 0.5; // Max 0.5 SOL per transfer
  private readonly DEFAULT_FUND_THRESHOLD = 0.3; // Fund agents below 0.3 SOL

  private pendingRequests: Map<string, FundRequest> = new Map();
  private fulfilledRequests: Map<string, FundRequest> = new Map();
  private agentCredits: Map<string, AgentCredit> = new Map();
  private tokens: Map<string, TokenConfig> = new Map();
  
  private totalFunded = 0;
  private totalRepaid = 0;
  private activeLoans = 0;

  constructor(
    config: AgentConfig,
    connection: Connection,
    walletManager: WalletManager
  ) {
    super(config, connection, walletManager);
    this.scanIntervalMs = this.SCAN_INTERVAL_MS;
    this.loadTokens();
    
    // Subscribe to fund requests
    messageBus.subscribe(config.id, ['FUND_REQUEST', 'FUNDS_REPAYMENT']);
  }

  private loadTokens(): void {
    const mintsPath = path.resolve(process.cwd(), 'token-mints.json');
    if (fs.existsSync(mintsPath)) {
      const mintsData = JSON.parse(fs.readFileSync(mintsPath, 'utf-8'));
      
      // Handle both formats: { tokens: [...] } or { SYMBOL: { mint, ... } }
      const tokenList = mintsData.tokens || mintsData;
      
      for (const [key, value] of Object.entries(tokenList)) {
        const tokenInfo = value as any;
        // If it's an array item, use symbol property; if object property, use key
        const symbol = tokenInfo.symbol || key;
        if (tokenInfo.mint) {
          this.tokens.set(symbol, {
            symbol,
            mint: tokenInfo.mint,
            decimals: tokenInfo.decimals || 6,
          });
        }
      }
    }
    
    console.log(`[${this.state.config.id}]   Loaded ${this.tokens.size} tokens for transfers`);
  }

  async executeStrategy(): Promise<void> {
    console.log(`\n[${this.state.config.id}] 🏦 Banker Agent - Swarm Liquidity Provider`);
    console.log(`[${this.state.config.id}] Balance: ${this.state.balance.toFixed(4)} SOL`);
    console.log(`[${this.state.config.id}] Available to lend: ${Math.max(0, this.state.balance - this.MIN_BANKER_RESERVE).toFixed(4)} SOL`);

    // If Banker is low on SOL, liquidate tokens to replenish
    if (this.state.balance < this.MIN_BANKER_RESERVE) {
      console.log(`[${this.state.config.id}] ⚠️ Banker SOL below reserve threshold (${this.MIN_BANKER_RESERVE} SOL)`);
      await this.liquidateTokensForSol(this.MIN_BANKER_RESERVE * 2); // Target 2x reserve
    }

    // Process any pending requests
    await this.processPendingRequests();

    // Proactively check known agent balances and offer funds
    await this.checkAgentBalances();

    // Print stats
    this.printStats();
  }

  private async processPendingRequests(): Promise<void> {
    for (const [id, request] of this.pendingRequests) {
      if (request.status !== 'PENDING') continue;

      console.log(`\n[${this.state.config.id}] 📝 Processing fund request from ${request.requesterId}`);
      console.log(`[${this.state.config.id}]   Token: ${request.token}, Amount: ${request.amount}`);
      console.log(`[${this.state.config.id}]   Reason: ${request.reason}`);
      console.log(`[${this.state.config.id}]   Urgency: ${request.urgency}`);

      const decision = await this.evaluateRequest(request);
      
      if (decision.approved) {
        request.status = 'APPROVED';
        const success = await this.transferFunds(request);
        if (success) {
          request.status = 'FULFILLED';
          this.fulfilledRequests.set(id, request);
          this.pendingRequests.delete(id);
        }
      } else {
        request.status = 'REJECTED';
        console.log(`[${this.state.config.id}]   ❌ REJECTED: ${decision.reason}`);
        
        // Notify requester
        messageBus.broadcast({
          from: this.state.config.id,
          to: request.requesterId,
          type: 'FUND_REJECTED',
          payload: {
            requestId: id,
            reason: decision.reason,
          },
        });
        this.pendingRequests.delete(id);
      }
    }
  }

  private async evaluateRequest(request: FundRequest): Promise<{ approved: boolean; reason?: string }> {
    // Check banker balance
    if (this.state.balance < this.MIN_BANKER_RESERVE + request.amount) {
      return { approved: false, reason: 'Insufficient banker reserves' };
    }

    // Check max transfer limit
    if (request.amount > this.MAX_SINGLE_TRANSFER) {
      return { approved: false, reason: 'Amount exceeds max transfer limit' };
    }

    // Get or create agent credit record
    let credit = this.agentCredits.get(request.requesterId);
    if (!credit) {
      credit = {
        agentId: request.requesterId,
        totalRequested: 0,
        totalReceived: 0,
        totalRepaid: 0,
        currentDebt: 0,
        requestCount: 0,
        trustScore: 50, // Start neutral
      };
      this.agentCredits.set(request.requesterId, credit);
    }

    // Check trust score
    if (credit.trustScore < 20) {
      return { approved: false, reason: 'Trust score too low' };
    }

    // Check current debt
    if (credit.currentDebt > 1.0) {
      return { approved: false, reason: 'Outstanding debt too high' };
    }

    // Check request frequency (prevent spam)
    if (credit.lastRequestAt) {
      const minutesSinceLastRequest = (Date.now() - credit.lastRequestAt.getTime()) / (1000 * 60);
      if (minutesSinceLastRequest < 5) {
        return { approved: false, reason: 'Too frequent requests' };
      }
    }

    return { approved: true };
  }

  private async transferFunds(request: FundRequest): Promise<boolean> {
    console.log(`\n[${this.state.config.id}] 💸 TRANSFERRING FUNDS to ${request.requesterId}`);
    console.log(`[${this.state.config.id}]   Token: ${request.token}`);
    console.log(`[${this.state.config.id}]   Amount: ${request.amount}`);

    try {
      const wallet = this.state.wallet.keypair;
      const recipientPubkey = await this.getAgentPubkey(request.requesterId);
      
      if (!recipientPubkey) {
        console.error(`[${this.state.config.id}]   ❌ Could not resolve pubkey for ${request.requesterId}`);
        return false;
      }

      let signature: string;

      if (request.token === 'SOL') {
        // Transfer SOL
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey: recipientPubkey,
            lamports: Math.floor(request.amount * LAMPORTS_PER_SOL),
          })
        );

        signature = await sendAndConfirmTransaction(this.connection, tx, [wallet]);
      } else {
        // Transfer token
        const tokenConfig = this.tokens.get(request.token);
        if (!tokenConfig) {
          console.error(`[${this.state.config.id}]   ❌ Unknown token: ${request.token}`);
          return false;
        }

        const mint = new PublicKey(tokenConfig.mint);
        const senderAta = getAssociatedTokenAddressSync(mint, wallet.publicKey);
        const recipientAta = getAssociatedTokenAddressSync(mint, recipientPubkey);

        // Create ATA if needed
        try {
          await getAccount(this.connection, recipientAta);
        } catch {
          // Create ATA for recipient
          const createAtaTx = new Transaction().add(
            createAssociatedTokenAccountInstruction(wallet.publicKey, recipientAta, recipientPubkey, mint)
          );
          await sendAndConfirmTransaction(this.connection, createAtaTx, [wallet]);
        }

        const amountRaw = Math.floor(request.amount * 10 ** tokenConfig.decimals);

        const tx = new Transaction().add(
          createTransferInstruction(senderAta, recipientAta, wallet.publicKey, amountRaw)
        );

        signature = await sendAndConfirmTransaction(this.connection, tx, [wallet]);
      }

      request.txSignature = signature;
      request.fulfilledAt = new Date();

      // Update credit record
      const credit = this.agentCredits.get(request.requesterId)!;
      credit.totalRequested += request.amount;
      credit.totalReceived += request.amount;
      credit.currentDebt += request.amount;
      credit.requestCount++;
      credit.lastRequestAt = new Date();

      this.totalFunded += request.amount;
      this.activeLoans++;

      console.log(`[${this.state.config.id}]   ✅ Transfer successful!`);
      console.log(`[${this.state.config.id}]   TX: ${signature.slice(0, 40)}...`);
      console.log(`[${this.state.config.id}]   ${request.requesterId} new debt: ${credit.currentDebt.toFixed(4)} ${request.token}`);

      // Log transaction
      TransactionLogger.log({
        agentId: this.state.config.id,
        agentType: this.state.config.type,
        type: 'LOAN',
        token: request.token,
        action: 'SEND',
        amount: request.amount,
        price: 1,
        solAmount: request.token === 'SOL' ? request.amount : 0,
        txSignature: signature,
        metadata: { 
          recipient: request.requesterId, 
          reason: request.reason,
          trustScore: credit.trustScore,
        },
      });

      // Notify recipient
      messageBus.broadcast({
        from: this.state.config.id,
        to: request.requesterId,
        type: 'FUNDS_SENT',
        payload: {
          requestId: request.id,
          token: request.token,
          amount: request.amount,
          txSignature: signature,
          remainingDebt: credit.currentDebt,
        },
      });

      return true;

    } catch (e: any) {
      console.error(`[${this.state.config.id}]   ❌ Transfer failed:`, e.message);
      return false;
    }
  }

  private async checkAgentBalances(): Promise<void> {
    // Check balances of known agents and transfer funds directly if low
    // (Agents run in separate processes, so MessageBus doesn't work for IPC)
    const allWallets = this.walletManager.getAllWallets();
    
    for (const wallet of allWallets) {
      if (wallet.agentId === this.state.config.id) continue; // Skip self

      try {
        const balance = await this.walletManager.getBalance(wallet.agentId);
        
        if (balance < this.DEFAULT_FUND_THRESHOLD) {
          console.log(`\n[${this.state.config.id}] ⚠️  ${wallet.agentId} balance low: ${balance.toFixed(4)} SOL`);
          
          // Check existing debt
          const credit = this.agentCredits.get(wallet.agentId);
          
          // Transfer funds directly (skip the request/response flow)
          if (!credit || credit.currentDebt < 0.5) {
            const transferAmount = Math.min(0.2, this.state.balance - this.MIN_BANKER_RESERVE);
            if (transferAmount > 0.05) {
              console.log(`[${this.state.config.id}]   💸 Auto-transferring ${transferAmount.toFixed(4)} SOL to ${wallet.agentId}`);
              
              // Create a fund request and fulfill it immediately
              const request: FundRequest = {
                id: `auto-${Date.now()}-${wallet.agentId}`,
                requesterId: wallet.agentId,
                token: 'SOL',
                amount: transferAmount,
                reason: 'Low balance auto-assistance',
                urgency: 'HIGH',
                status: 'PENDING',
                requestedAt: new Date(),
              };
              
              this.pendingRequests.set(request.id, request);
              await this.transferFunds(request);
            }
          } else {
            console.log(`[${this.state.config.id}]   ⏸️  Skipping: ${wallet.agentId} already has ${credit.currentDebt.toFixed(4)} SOL debt`);
          }
        }
      } catch (e: any) {
        // Ignore errors for individual agents
      }
    }
  }

  private async getAgentPubkey(agentId: string): Promise<PublicKey | null> {
    // Try to get from wallet manager first
    const agentWallet = this.walletManager.getWallet(agentId);
    if (agentWallet) {
      return agentWallet.publicKey;
    }
    
    // Otherwise try to parse as public key
    try {
      return new PublicKey(agentId);
    } catch {
      return null;
    }
  }

  async handleMessage(message: AgentMessage): Promise<void> {
    console.log(`[${this.state.config.id}] 📨 Received: ${message.type} from ${message.from}`);

    if (message.type === 'FUND_REQUEST') {
      const { token, amount, reason, urgency } = message.payload;
      
      const request: FundRequest = {
        id: `req-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
        requesterId: message.from,
        token: token || 'SOL',
        amount: amount || 0.1,
        reason: reason || 'No reason provided',
        urgency: urgency || 'MEDIUM',
        status: 'PENDING',
        requestedAt: new Date(),
      };

      this.pendingRequests.set(request.id, request);
      console.log(`[${this.state.config.id}]   📝 Queued fund request: ${request.id}`);
    }

    if (message.type === 'FUNDS_REPAYMENT') {
      const { amount, token } = message.payload;
      console.log(`[${this.state.config.id}]   💰 Repayment received: ${amount} ${token}`);

      const credit = this.agentCredits.get(message.from);
      if (credit) {
        credit.totalRepaid += amount;
        credit.currentDebt = Math.max(0, credit.currentDebt - amount);
        credit.trustScore = Math.min(100, credit.trustScore + 5); // Increase trust
        
        this.totalRepaid += amount;
        this.activeLoans = Math.max(0, this.activeLoans - 1);

        console.log(`[${this.state.config.id}]   📈 ${message.from} trust score: ${credit.trustScore} (+5)`);
        console.log(`[${this.state.config.id}]   Remaining debt: ${credit.currentDebt.toFixed(4)} ${token}`);

        TransactionLogger.log({
          agentId: this.state.config.id,
          agentType: this.state.config.type,
          type: 'LOAN',
          token: token || 'SOL',
          action: 'RECEIVE_REPAYMENT',
          amount: amount,
          price: 1,
          solAmount: token === 'SOL' ? amount : 0,
          metadata: { from: message.from, type: 'repayment' },
        });
      }
    }
  }

  private printStats(): void {
    const pendingCount = Array.from(this.pendingRequests.values()).filter(r => r.status === 'PENDING').length;
    const fulfilledCount = this.fulfilledRequests.size;

    console.log(`\n[${this.state.config.id}] 📊 BANKER STATS`);
    console.log(`[${this.state.config.id}]   Total funded: ${this.totalFunded.toFixed(4)} SOL`);
    console.log(`[${this.state.config.id}]   Total repaid: ${this.totalRepaid.toFixed(4)} SOL`);
    console.log(`[${this.state.config.id}]   Active loans: ${this.activeLoans}`);
    console.log(`[${this.state.config.id}]   Pending requests: ${pendingCount}`);
    console.log(`[${this.state.config.id}]   Fulfilled requests: ${fulfilledCount}`);
    console.log(`[${this.state.config.id}]   Agent credits: ${this.agentCredits.size}`);

    if (this.agentCredits.size > 0) {
      console.log(`[${this.state.config.id}]   Credit summary:`);
      for (const [id, credit] of this.agentCredits) {
        const emoji = credit.trustScore > 70 ? '🟢' : credit.trustScore > 40 ? '🟡' : '🔴';
        console.log(`[${this.state.config.id}]     ${emoji} ${id.slice(0, 20)}...: Trust ${credit.trustScore}, Debt: ${credit.currentDebt.toFixed(3)} SOL`);
      }
    }
  }

  getStats() {
    return {
      totalFunded: this.totalFunded,
      totalRepaid: this.totalRepaid,
      activeLoans: this.activeLoans,
      pendingRequests: this.pendingRequests.size,
      agentCredits: Array.from(this.agentCredits.entries()),
    };
  }
}
