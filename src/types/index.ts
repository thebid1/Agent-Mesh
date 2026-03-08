import { Keypair, PublicKey } from '@solana/web3.js';

export interface AgentWallet {
  keypair: Keypair;
  publicKey: PublicKey;
  derivationPath: string;
  agentId: string;
  agentType: AgentType;
}

export type AgentType = 'ARBITRAGEUR' | 'LIQUIDITY_PROVIDER' | 'TREND_FOLLOWER' | 'BANKER' | 'CUSTOM';

export interface AgentConfig {
  id: string;
  type: AgentType;
  name: string;
  description: string;
  initialBalance: number;
  maxSlippage: number;
  dailyTradeLimit: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface AgentState {
  wallet: AgentWallet;
  config: AgentConfig;
  status: 'INITIALIZING' | 'ACTIVE' | 'PAUSED' | 'ERROR';
  balance: number;
  portfolio: PortfolioItem[];
  dailyStats: DailyStats;
  totalStats: TotalStats;
  lastAction: AgentAction | null;
}

export interface PortfolioItem {
  mint: string;
  symbol: string;
  balance: number;
  valueUsd: number;
}

export interface DailyStats {
  tradesExecuted: number;
  tradesFailed: number;
  volumeTraded: number;
  profitLoss: number;
  gasSpent: number;
  startTime: Date;
}

export interface TotalStats {
  totalTrades: number;
  totalVolume: number;
  totalProfitLoss: number;
  totalGasSpent: number;
  startTime: Date;
}

export interface AgentAction {
  type: 'SWAP' | 'ADD_LIQUIDITY' | 'REMOVE_LIQUIDITY' | 'TRANSFER' | 'MESSAGE' | 'LOAN';
  timestamp: Date;
  txSignature?: string;
  description: string;
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  error?: string;
}

export interface AgentMessage {
  id?: string;
  from: string;
  to: string | 'BROADCAST';
  type: 'TRADE_PROPOSED' | 'ARBITRAGE_OPPORTUNITY' | 'LIQUIDITY_UPDATE' | 'LIQUIDITY_REQUEST' | 'RISK_ALERT' | 'HEARTBEAT' |
        'OPPORTUNITY' | 'TRADE_EXECUTED' | 'LOAN_OFFER' | 'LOAN_REQUEST' | 'PRICE_UPDATE' |
        'FUND_REQUEST' | 'FUNDS_SENT' | 'FUND_REJECTED' | 'FUND_OFFER' | 'FUNDS_REPAYMENT';
  payload: any;
  timestamp: Date;
  ttl?: number;
}

export interface TransactionResult {
  success: boolean;
  signature?: string;
  error?: string;
}
