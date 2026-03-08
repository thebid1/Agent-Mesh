/**
 * Unified Transaction Logger
 * 
 * Logs all agent transactions to a single file for analysis
 * Creates a comprehensive trading history
 */

import * as fs from 'fs';
import * as path from 'path';

export interface TransactionRecord {
  id: string;
  timestamp: string;
  agentId: string;
  agentType: string;
  type: 'TRADE' | 'LIQUIDITY_ADD' | 'LIQUIDITY_REMOVE' | 'LOAN' | 'BORROW' | 'TRANSFER';
  token: string;
  action: 'BUY' | 'SELL' | 'ADD' | 'REMOVE' | 'SEND' | 'RECEIVE' | 'ISSUE' | 'REPAY' | 'RECEIVE_REPAYMENT';
  amount: number;
  price: number;
  solAmount: number;
  pnl?: number;
  txSignature?: string;
  explorerUrl?: string;
  metadata?: any;
}

// Single unified log - no rotation, all transactions preserved forever
const LOG_DIR = path.resolve(process.cwd(), 'logs');
const UNIFIED_LOG = path.join(LOG_DIR, 'all-transactions.json');

export class TransactionLogger {
  private static ensureLogDir(): void {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
  }

  static log(record: Omit<TransactionRecord, 'id' | 'timestamp' | 'explorerUrl'>): void {
    this.ensureLogDir();

    const fullRecord: TransactionRecord = {
      ...record,
      id: this.generateId(),
      timestamp: new Date().toISOString(),
      explorerUrl: record.txSignature ? `https://explorer.solana.com/tx/${record.txSignature}?cluster=devnet` : undefined,
    };

    // Append to unified log - NEVER rotated, all transactions preserved
    let transactions: TransactionRecord[] = [];
    if (fs.existsSync(UNIFIED_LOG)) {
      try {
        transactions = JSON.parse(fs.readFileSync(UNIFIED_LOG, 'utf-8'));
        if (!Array.isArray(transactions)) transactions = [];
      } catch {
        transactions = []; // Reset if corrupted
      }
    }
    transactions.push(fullRecord);
    fs.writeFileSync(UNIFIED_LOG, JSON.stringify(transactions, null, 2));

    // Console output with formatting
    console.log(`\n💾 LOGGED: ${record.agentId} ${record.action} ${record.amount} ${record.token}`);
    if (record.txSignature) {
      console.log(`   TX: ${record.txSignature.slice(0, 40)}...`);
    }
    if (record.pnl !== undefined) {
      console.log(`   P&L: ${record.pnl >= 0 ? '+' : ''}${record.pnl.toFixed(6)} SOL`);
    }
  }

  static getAllTransactions(): TransactionRecord[] {
    if (!fs.existsSync(UNIFIED_LOG)) return [];
    return JSON.parse(fs.readFileSync(UNIFIED_LOG, 'utf-8'));
  }

  static getTransactionsByAgent(agentId: string): TransactionRecord[] {
    return this.getAllTransactions().filter(t => t.agentId === agentId);
  }

  static getTransactionsByToken(token: string): TransactionRecord[] {
    return this.getAllTransactions().filter(t => t.token === token);
  }

  static getDailyStats(date: string = new Date().toISOString().split('T')[0]): {
    totalTrades: number;
    totalVolume: number;
    totalPnL: number;
    agents: Record<string, { trades: number; pnl: number }>;
  } {
    // Filter transactions by date from unified log
    const allTransactions = this.getAllTransactions();
    const transactions = allTransactions.filter(t => t.timestamp.startsWith(date));
    
    const stats = {
      totalTrades: transactions.length,
      totalVolume: transactions.reduce((sum, t) => sum + t.solAmount, 0),
      totalPnL: transactions.reduce((sum, t) => sum + (t.pnl || 0), 0),
      agents: {} as Record<string, { trades: number; pnl: number }>,
    };

    for (const t of transactions) {
      if (!stats.agents[t.agentId]) {
        stats.agents[t.agentId] = { trades: 0, pnl: 0 };
      }
      stats.agents[t.agentId].trades++;
      stats.agents[t.agentId].pnl += t.pnl || 0;
    }

    return stats;
  }

  static printDashboard(): void {
    const transactions = this.getAllTransactions();
    const recent = transactions.slice(-20);
    const stats = this.getDailyStats();

    console.log('\n' + '='.repeat(80));
    console.log('📊 TRANSACTION DASHBOARD');
    console.log('='.repeat(80));
    
    console.log(`\nTotal Transactions: ${transactions.length}`);
    console.log(`Today's Trades: ${stats.totalTrades}`);
    console.log(`Today's Volume: ${stats.totalVolume.toFixed(4)} SOL`);
    console.log(`Today's P&L: ${stats.totalPnL >= 0 ? '+' : ''}${stats.totalPnL.toFixed(6)} SOL`);
    
    if (Object.keys(stats.agents).length > 0) {
      console.log('\nAgent Performance:');
      for (const [agent, data] of Object.entries(stats.agents)) {
        const emoji = data.pnl >= 0 ? '🟢' : '🔴';
        console.log(`  ${emoji} ${agent}: ${data.trades} trades, P&L: ${data.pnl >= 0 ? '+' : ''}${data.pnl.toFixed(6)} SOL`);
      }
    }

    if (recent.length > 0) {
      console.log('\nRecent Transactions:');
      for (const t of recent.slice(-5)) {
        const time = new Date(t.timestamp).toLocaleTimeString();
        const pnlStr = t.pnl !== undefined ? ` | P&L: ${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(4)}` : '';
        console.log(`  [${time}] ${t.agentId} ${t.action} ${t.amount} ${t.token} @ ${t.price.toFixed(4)}${pnlStr}`);
      }
    }

    console.log('\n' + '='.repeat(80));
  }

  private static generateId(): string {
    return `tx-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  static clear(): void {
    this.ensureLogDir();
    if (fs.existsSync(UNIFIED_LOG)) {
      fs.unlinkSync(UNIFIED_LOG);
    }
    console.log('🗑️ Transaction log cleared');
  }
}
