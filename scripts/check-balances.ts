#!/usr/bin/env ts-node
/**
 * Check Agent Balances
 * 
 * Displays SOL and all token balances for treasury and agents.
 * Usage: npm run check-balances
 */

import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { 
  getAssociatedTokenAddress, 
  getAccount,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import * as fs from 'fs';
import { NETWORK, AGENT_TOKENS, TOKEN_DECIMALS } from '../src/config';
import { decryptKeypair, isValidEncryptionKey } from '../src/utils/encryption';

const RPC_URL = process.env.SOLANA_RPC_URL || NETWORK.RPC_URL;
const WALLET_REGISTRY_PATH = './wallet-registry.json';
const TREASURY_KEYPAIR_PATH = './treasury-keypair.enc.json';

interface TokenInfo {
  symbol: string;
  mint: string;
  decimals: number;
}

const AGENT_TOKEN_LIST: TokenInfo[] = [
  { symbol: 'AUSDC', mint: AGENT_TOKENS.AUSDC, decimals: TOKEN_DECIMALS[AGENT_TOKENS.AUSDC] },
  { symbol: 'ABTC', mint: AGENT_TOKENS.ABTC, decimals: TOKEN_DECIMALS[AGENT_TOKENS.ABTC] },
  { symbol: 'ASOL', mint: AGENT_TOKENS.ASOL, decimals: TOKEN_DECIMALS[AGENT_TOKENS.ASOL] },
  { symbol: 'AETH', mint: AGENT_TOKENS.AETH, decimals: TOKEN_DECIMALS[AGENT_TOKENS.AETH] },
];

async function getTokenBalance(connection: Connection, owner: PublicKey, mint: string): Promise<number> {
  try {
    const mintPubkey = new PublicKey(mint);
    const ata = await getAssociatedTokenAddress(mintPubkey, owner);
    const account = await getAccount(connection, ata);
    return Number(account.amount);
  } catch {
    return 0;
  }
}

function formatTokenAmount(amount: number, decimals: number): string {
  return (amount / Math.pow(10, decimals)).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals > 6 ? 4 : 2,
  });
}

async function main() {
  console.log('='.repeat(80));
  console.log('  AGENT MESH - Balance Validator');
  console.log('='.repeat(80));
  console.log();

  if (!fs.existsSync(TREASURY_KEYPAIR_PATH)) {
    console.error('✗ Treasury keypair not found. Run: npm run generate-treasury');
    process.exit(1);
  }

  if (!fs.existsSync(WALLET_REGISTRY_PATH)) {
    console.error('✗ No agents found. Run: npm run init-interactive');
    process.exit(1);
  }

  // Load and decrypt treasury
  const encryptionKey = process.env.WALLET_ENCRYPTION_KEY || '';
  if (!encryptionKey || !isValidEncryptionKey(encryptionKey)) {
    console.error('✗ WALLET_ENCRYPTION_KEY not set or invalid');
    process.exit(1);
  }

  const treasuryEncrypted = JSON.parse(fs.readFileSync(TREASURY_KEYPAIR_PATH, 'utf-8'));
  const treasurySecret = decryptKeypair(treasuryEncrypted, encryptionKey);
  const treasuryKeypair = require('@solana/web3.js').Keypair.fromSecretKey(treasurySecret);
  const registry = JSON.parse(fs.readFileSync(WALLET_REGISTRY_PATH, 'utf-8'));

  const connection = new Connection(RPC_URL, 'confirmed');

  // Check treasury
  console.log('┌' + '─'.repeat(78) + '┐');
  console.log('│' + ' '.repeat(25) + 'TREASURY' + ' '.repeat(45) + '│');
  console.log('├' + '─'.repeat(78) + '┤');
  console.log(`│ Address: ${treasuryKeypair.publicKey.toString().padEnd(57)} │`);
  console.log('├' + '─'.repeat(78) + '┤');

  const treasurySol = await connection.getBalance(treasuryKeypair.publicKey) / LAMPORTS_PER_SOL;
  console.log(`│ SOL:        ${treasurySol.toFixed(4).padEnd(62)} │`);

  for (const token of AGENT_TOKEN_LIST) {
    const balance = await getTokenBalance(connection, treasuryKeypair.publicKey, token.mint);
    const formatted = formatTokenAmount(balance, token.decimals);
    console.log(`│ ${token.symbol.padEnd(10)} ${formatted.padEnd(62)} │`);
  }
  console.log('└' + '─'.repeat(78) + '┘');
  console.log();

  // Check agents
  for (let i = 0; i < registry.agents.length; i++) {
    const agent = registry.agents[i];
    const pubkey = new PublicKey(agent.publicKey);

    console.log('┌' + '─'.repeat(78) + '┐');
    console.log(`│ ${(i + 1).toString().padStart(2)}. ${agent.name.toUpperCase()}${' '.repeat(78 - agent.name.length - 5)}│`);
    console.log('├' + '─'.repeat(78) + '┤');
    console.log(`│ ID:         ${agent.id.padEnd(62)} │`);
    console.log(`│ Type:       ${agent.type.padEnd(62)} │`);
    console.log(`│ Address:    ${agent.publicKey.padEnd(62)} │`);
    console.log('├' + '─'.repeat(78) + '┤');

    const solBalance = await connection.getBalance(pubkey) / LAMPORTS_PER_SOL;
    console.log(`│ SOL:        ${solBalance.toFixed(4).padEnd(62)} │`);

    for (const token of AGENT_TOKEN_LIST) {
      const balance = await getTokenBalance(connection, pubkey, token.mint);
      const formatted = formatTokenAmount(balance, token.decimals);
      const displaySymbol = token.symbol.padEnd(10);
      console.log(`│ ${displaySymbol} ${formatted.padEnd(62)} │`);
    }
    console.log('└' + '─'.repeat(78) + '┘');
    console.log();
  }

  // Summary
  console.log('='.repeat(80));
  console.log('  SUMMARY');
  console.log('='.repeat(80));
  console.log();

  const allAddresses = [treasuryKeypair.publicKey, ...registry.agents.map((a: any) => new PublicKey(a.publicKey))];
  
  console.log('Total Wallets:'.padEnd(20), allAddresses.length);
  console.log('Agents:'.padEnd(20), registry.agents.length);
  console.log();

  // Calculate total holdings across all wallets
  console.log('Combined Holdings:');
  console.log('-'.repeat(40));
  
  let totalSol = 0;
  const tokenTotals: Record<string, number> = {};
  
  for (const token of AGENT_TOKEN_LIST) {
    tokenTotals[token.symbol] = 0;
  }

  for (const address of allAddresses) {
    totalSol += await connection.getBalance(address) / LAMPORTS_PER_SOL;
    for (const token of AGENT_TOKEN_LIST) {
      tokenTotals[token.symbol] += await getTokenBalance(connection, address, token.mint);
    }
  }

  console.log(`SOL:        ${totalSol.toFixed(4)}`);
  for (const token of AGENT_TOKEN_LIST) {
    const formatted = formatTokenAmount(tokenTotals[token.symbol], token.decimals);
    console.log(`${token.symbol.padEnd(10)} ${formatted}`);
  }
  
  console.log();
  console.log('='.repeat(80));
  console.log('✓ Balance check complete!');
  console.log('='.repeat(80));
}

main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
