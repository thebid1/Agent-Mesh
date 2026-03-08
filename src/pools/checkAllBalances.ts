/**
 * Check All Agent Balances (SOL + All AGENT Tokens)
 * 
 * Run: npx ts-node src/pools/checkAllBalances.ts
 */

import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { NETWORK } from '../config';
import * as fs from 'fs';
import * as path from 'path';

const TOKENS = [
  { symbol: 'AUSDC', mint: 'B7tFhVdFeafrdBcCEWsjDXr3rUqkwXMmtbDKkJDy6PqE', decimals: 6 },
  { symbol: 'ABTC', mint: 'eL6FAw3nzY8ftwjwtgJnGWAdb4aNZHmsK5H39f2F4tN', decimals: 6 },
  { symbol: 'AETH', mint: '8L4wBtjbS4bjJXDhg8QHpVkvNfqamvCddAzqtMetr1DC', decimals: 6 },
  { symbol: 'ASOL', mint: '4XXFcpZM7w2RD2r8nQz2UST67f8kef4JohPzp1Y72Y69', decimals: 6 },
];

interface AgentEntry {
  file: string;
  name: string;
  id: string;
  encrypted: boolean;
}

/**
 * Load agents dynamically from agents.config.json
 */
function loadAgents(): AgentEntry[] {
  const configPath = path.resolve(process.cwd(), 'agents.config.json');
  if (!fs.existsSync(configPath)) {
    console.error('❌ agents.config.json not found. Run `npm run init` first.');
    return [];
  }
  
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  
  return (config.agents || []).map((agent: any) => ({
    file: `${agent.id}-keypair.enc.json`,
    name: agent.label || agent.id,
    id: agent.id,
    encrypted: true,
  }));
}

async function getTokenBalance(connection: Connection, wallet: PublicKey, mint: PublicKey, decimals: number): Promise<number> {
  try {
    const ata = getAssociatedTokenAddressSync(mint, wallet);
    const balance = await connection.getTokenAccountBalance(ata);
    return Number(balance.value.amount) / 10 ** decimals;
  } catch {
    return 0;
  }
}

async function checkAgent(connection: Connection, agent: AgentEntry) {
  const agentPath = path.resolve(process.cwd(), 'agent-keypairs', agent.file);
  
  if (!fs.existsSync(agentPath)) {
    console.log(`\n❌ ${agent.name}: Wallet not found (${agent.file})`);
    return;
  }

  const { Keypair } = await import('@solana/web3.js');
  
  // Handle encrypted keypairs
  let secretKey: Uint8Array;
  if (agent.encrypted) {
    // For encrypted keypairs, just read the JSON structure but don't decrypt
    // This script expects raw keypairs, so skip encrypted ones
    console.log(`\n⚠️  ${agent.name}: Encrypted keypair (run with decrypted keypairs only)`);
    return;
  } else {
    const keyData: number[] = JSON.parse(fs.readFileSync(agentPath, 'utf-8'));
    secretKey = new Uint8Array(keyData);
  }
  
  const wallet = Keypair.fromSecretKey(secretKey);

  console.log(`\n👤 ${agent.name}`);
  console.log(`   ID: ${agent.id}`);
  console.log(`   Address: ${wallet.publicKey.toBase58()}`);

  // SOL Balance
  const solBalance = await connection.getBalance(wallet.publicKey);
  console.log(`   SOL: ${(solBalance / LAMPORTS_PER_SOL).toFixed(4)}`);

  // Token Balances
  console.log('   Tokens:');
  for (const token of TOKENS) {
    const balance = await getTokenBalance(connection, wallet.publicKey, new PublicKey(token.mint), token.decimals);
    if (balance > 0) {
      console.log(`      ${token.symbol}: ${balance.toLocaleString()}`);
    } else {
      console.log(`      ${token.symbol}: 0`);
    }
  }
}

async function checkTreasury(connection: Connection) {
  const treasuryPath = path.resolve(process.cwd(), 'treasury-keypair.json');
  
  if (!fs.existsSync(treasuryPath)) {
    console.log('\n❌ Treasury: Wallet not found');
    return;
  }

  const { Keypair } = await import('@solana/web3.js');
  const secretKey: number[] = JSON.parse(fs.readFileSync(treasuryPath, 'utf-8'));
  const wallet = Keypair.fromSecretKey(new Uint8Array(secretKey));

  console.log(`\n🏦 TREASURY`);
  console.log(`   Address: ${wallet.publicKey.toBase58()}`);

  const solBalance = await connection.getBalance(wallet.publicKey);
  console.log(`   SOL: ${(solBalance / LAMPORTS_PER_SOL).toFixed(4)}`);

  console.log('   Tokens:');
  for (const token of TOKENS) {
    const balance = await getTokenBalance(connection, wallet.publicKey, new PublicKey(token.mint), token.decimals);
    console.log(`      ${token.symbol}: ${balance.toLocaleString()}`);
  }
}

async function main() {
  const connection = new Connection(NETWORK.RPC_URL, 'confirmed');

  console.log('=' .repeat(70));
  console.log('  AGENT MESH - ALL BALANCES');
  console.log('=' .repeat(70));

  // Treasury
  await checkTreasury(connection);

  // All Agents
  const agents = loadAgents();
  if (agents.length === 0) {
    console.log('\n⚠️  No agents configured. Run `npm run init` first.');
  } else {
    for (const agent of agents) {
      await checkAgent(connection, agent);
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log('  POOL RESERVES');
  console.log('='.repeat(70));

  const poolPath = path.resolve(process.cwd(), 'pool-configs.json');
  if (fs.existsSync(poolPath)) {
    const pools = JSON.parse(fs.readFileSync(poolPath, 'utf-8'));
    
    for (const [symbol, pool] of Object.entries(pools as Record<string, any>)) {
      try {
        const vaultA = await connection.getTokenAccountBalance(new PublicKey(pool.vaultA));
        const vaultB = await connection.getTokenAccountBalance(new PublicKey(pool.vaultB));
        const tokenReserve = Number(vaultA.value.amount) / 10 ** (pool.decimalsA || 6);
        const solReserve = Number(vaultB.value.amount) / LAMPORTS_PER_SOL;
        
        console.log(`\n🏊 ${symbol}/SOL Pool`);
        console.log(`   ${symbol}: ${tokenReserve.toLocaleString()}`);
        console.log(`   SOL: ${solReserve.toFixed(4)}`);
        console.log(`   Price: 1 SOL = ${(tokenReserve / solReserve).toFixed(2)} ${symbol}`);
      } catch (e) {
        console.log(`\n🏊 ${symbol}: Error reading reserves`);
      }
    }
  }

  console.log('\n' + '='.repeat(70) + '\n');
}

main().catch(console.error);
