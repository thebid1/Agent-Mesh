import dotenv from 'dotenv';

dotenv.config();

export const NETWORK = {
  RPC_URL: process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
  COMMITMENT: 'confirmed' as const,
};

export const TREASURY = {
  KEYPAIR_PATH: process.env.TREASURY_KEYPAIR_PATH || './treasury-keypair.json',
  MIN_BALANCE_THRESHOLD: 0.1,
};

export const AI_CONFIG = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  MODEL: 'gemini-2.5-flash',
};

export const JUPITER_CONFIG = {
  API_BASE: 'https://quote-api.jup.ag/v6',
  SLIPPAGE_BPS: 50,
};

/**
 * Agent Mesh Custom Token Mint Addresses (Devnet) - NEW TOKENS 2026-03-01
 */
export const AGENT_TOKENS = {
  AUSDC: 'B7tFhVdFeafrdBcCEWsjDXr3rUqkwXMmtbDKkJDy6PqE',
  ABTC: 'eL6FAw3nzY8ftwjwtgJnGWAdb4aNZHmsK5H39f2F4tN',
  AETH: '8L4wBtjbS4bjJXDhg8QHpVkvNfqamvCddAzqtMetr1DC',
  ASOL: '4XXFcpZM7w2RD2r8nQz2UST67f8kef4JohPzp1Y72Y69',
};

/**
 * Token decimals for agent mesh tokens - ALL 6 DECIMALS
 */
export const TOKEN_DECIMALS: Record<string, number> = {
  [AGENT_TOKENS.AUSDC]: 6,
  [AGENT_TOKENS.ABTC]: 6,
  [AGENT_TOKENS.AETH]: 6,
  [AGENT_TOKENS.ASOL]: 6,
  'So11111111111111111111111111111111111111112': 9, // SOL
};

export const CIRCUIT_BREAKER = {
  MAX_DAILY_LOSS_PERCENT: parseFloat(process.env.MAX_DAILY_LOSS_PERCENT || '10'),
  MAX_CONSECUTIVE_FAILURES: parseInt(process.env.MAX_CONSECUTIVE_FAILURES || '5'),
};

export { AGENT_DEFINITIONS } from './agent-definitions';
export type { AgentDefinition } from './agent-definitions';
