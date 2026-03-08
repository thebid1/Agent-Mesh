import { Connection, PublicKey } from '@solana/web3.js';

/**
 * Token registry for common devnet tokens
 */
export const KNOWN_TOKENS: Record<string, { symbol: string; name: string; decimals: number }> = {
  'So11111111111111111111111111111111111111112': { symbol: 'SOL', name: 'Solana', decimals: 9 },
  '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU': { symbol: 'USDC', name: 'USD Coin (Devnet)', decimals: 6 },
  'EJRJswD9rKpHE9n7SzjRQcArzmZuMP8M3vPEjXXMmBcw': { symbol: 'USDT', name: 'Tether (Devnet)', decimals: 6 },
  // Agent Mesh Tokens (Mint Addresses)
  'B7tFhVdFeafrdBcCEWsjDXr3rUqkwXMmtbDKkJDy6PqE': { symbol: 'AUSDC', name: 'Agent Mesh USDC', decimals: 6 },
  'eL6FAw3nzY8ftwjwtgJnGWAdb4aNZHmsK5H39f2F4tN': { symbol: 'ABTC', name: 'Agent Mesh Bitcoin', decimals: 6 },
  '4XXFcpZM7w2RD2r8nQz2UST67f8kef4JohPzp1Y72Y69': { symbol: 'ASOL', name: 'Agent Mesh Solana', decimals: 6 },
  '8L4wBtjbS4bjJXDhg8QHpVkvNfqamvCddAzqtMetr1DC': { symbol: 'AETH', name: 'Agent Mesh Ethereum', decimals: 6 },
};

/**
 * Agent Mesh Token Mint Addresses (Devnet)
 */
export const AGENT_TOKENS = {
  AUSDC: 'B7tFhVdFeafrdBcCEWsjDXr3rUqkwXMmtbDKkJDy6PqE',
  ABTC: 'eL6FAw3nzY8ftwjwtgJnGWAdb4aNZHmsK5H39f2F4tN',
  ASOL: '4XXFcpZM7w2RD2r8nQz2UST67f8kef4JohPzp1Y72Y69',
  AETH: '8L4wBtjbS4bjJXDhg8QHpVkvNfqamvCddAzqtMetr1DC',
};


export async function getTokenInfo(connection: Connection, mint: string): Promise<{ symbol: string; name: string; decimals: number }> {
  // Check known tokens first
  if (KNOWN_TOKENS[mint]) {
    return KNOWN_TOKENS[mint];
  }

  // Try to fetch from chain
  try {
    const mintInfo = await connection.getParsedAccountInfo(new PublicKey(mint));
    if (mintInfo.value && 'parsed' in mintInfo.value.data) {
      const parsed = mintInfo.value.data.parsed;
      return {
        symbol: 'UNKNOWN',
        name: parsed.info.name || 'Unknown Token',
        decimals: parsed.info.decimals || 0,
      };
    }
  } catch {
    // Ignore errors
  }

  return { symbol: 'UNKNOWN', name: 'Unknown Token', decimals: 0 };
}
