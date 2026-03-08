#!/usr/bin/env ts-node
/**
 * Interactive Agent Funding (SOL + Tokens)
 * 
 * Funds agents with SOL and Agent Mesh tokens from treasury.
 * Uses encrypted key storage (AES-256-GCM).
 */

import { 
  Connection, 
  Keypair, 
  LAMPORTS_PER_SOL, 
  PublicKey,
  SystemProgram, 
  Transaction, 
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { 
  getAssociatedTokenAddress, 
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAccount,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import fs from 'fs';
import readline from 'readline';
import dotenv from 'dotenv';
import { NETWORK, TREASURY, AGENT_TOKENS, TOKEN_DECIMALS } from '../src/config';
import { decryptKeypair, isValidEncryptionKey } from '../src/utils/encryption';

dotenv.config();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const RPC_URL = process.env.SOLANA_RPC_URL || NETWORK.RPC_URL;
const WALLET_REGISTRY_PATH = './wallet-registry.json';

function ask(question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve));
}

console.log('='.repeat(70));
console.log('  AGENT MESH - Interactive Agent Funding');
console.log('='.repeat(70));
console.log();

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

async function transferToken(
  connection: Connection,
  fromKeypair: Keypair,
  toAddress: string,
  mint: string,
  amount: number,
  decimals: number
): Promise<string | null> {
  try {
    const mintPubkey = new PublicKey(mint);
    const toPubkey = new PublicKey(toAddress);
    
    const fromATA = await getAssociatedTokenAddress(mintPubkey, fromKeypair.publicKey);
    const toATA = await getAssociatedTokenAddress(mintPubkey, toPubkey);
    
    const tx = new Transaction();
    
    // Create recipient ATA if it doesn't exist
    try {
      await getAccount(connection, toATA);
    } catch {
      tx.add(
        createAssociatedTokenAccountInstruction(
          fromKeypair.publicKey,
          toATA,
          toPubkey,
          mintPubkey
        )
      );
    }
    
    // Add transfer instruction
    const amountInSmallestUnit = BigInt(Math.floor(amount * Math.pow(10, decimals)));
    tx.add(
      createTransferInstruction(
        fromATA,
        toATA,
        fromKeypair.publicKey,
        amountInSmallestUnit
      )
    );
    
    const signature = await sendAndConfirmTransaction(connection, tx, [fromKeypair]);
    return signature;
  } catch (error: any) {
    console.log(`  ✗ Token transfer failed: ${error.message.slice(0, 60)}`);
    return null;
  }
}

async function main() {
  if (!fs.existsSync(TREASURY.KEYPAIR_PATH)) {
    console.error(`✗ Treasury keypair not found: ${TREASURY.KEYPAIR_PATH}`);
    console.log('Run: npm run generate-treasury first');
    rl.close();
    process.exit(1);
  }

  if (!fs.existsSync(WALLET_REGISTRY_PATH)) {
    console.error('✗ No agents found. Run: npm run init-interactive first');
    rl.close();
    process.exit(1);
  }

  // Load and decrypt treasury keypair
  const encryptionKey = process.env.WALLET_ENCRYPTION_KEY;
  if (!encryptionKey) {
    console.error('✗ WALLET_ENCRYPTION_KEY not found in environment.');
    rl.close();
    process.exit(1);
  }
  if (!isValidEncryptionKey(encryptionKey)) {
    console.error('✗ Invalid WALLET_ENCRYPTION_KEY. Must be 64 hex characters.');
    rl.close();
    process.exit(1);
  }

  const treasuryEncrypted = JSON.parse(fs.readFileSync(TREASURY.KEYPAIR_PATH, 'utf-8'));
  const treasurySecret = decryptKeypair(treasuryEncrypted, encryptionKey);
  const treasuryKeypair = Keypair.fromSecretKey(treasurySecret);
  
  const registry = JSON.parse(fs.readFileSync(WALLET_REGISTRY_PATH, 'utf-8'));
  const agents = registry.agents;

  const connection = new Connection(RPC_URL, 'confirmed');

  console.log('Treasury:', treasuryKeypair.publicKey.toString());
  console.log('Encryption: ✓ AES-256-GCM');
  console.log(`Agents: ${agents.length}\n`);

  // Check treasury balances
  const solBalance = await connection.getBalance(treasuryKeypair.publicKey);
  const solBalanceFormatted = solBalance / LAMPORTS_PER_SOL;
  
  const tokenBalances: Record<string, number> = {};
  tokenBalances['AUSDC'] = await getTokenBalance(connection, treasuryKeypair.publicKey, AGENT_TOKENS.AUSDC);
  tokenBalances['ABTC'] = await getTokenBalance(connection, treasuryKeypair.publicKey, AGENT_TOKENS.ABTC);
  tokenBalances['ASOL'] = await getTokenBalance(connection, treasuryKeypair.publicKey, AGENT_TOKENS.ASOL);
  tokenBalances['AETH'] = await getTokenBalance(connection, treasuryKeypair.publicKey, AGENT_TOKENS.AETH);

  console.log('╔' + '═'.repeat(68) + '╗');
  console.log('║' + ' '.repeat(20) + 'TREASURY HOLDINGS' + ' '.repeat(31) + '║');
  console.log('╠' + '═'.repeat(68) + '╣');
  console.log(`║  SOL:        ${solBalanceFormatted.toFixed(4).padEnd(53)} ║`);
  console.log(`║  AUSDC:      ${(tokenBalances['AUSDC'] / 1e6).toFixed(2).padEnd(53)} ║`);
  console.log(`║  ABTC:       ${(tokenBalances['ABTC'] / 1e6).toFixed(4).padEnd(53)} ║`);
  console.log(`║  ASOL:       ${(tokenBalances['ASOL'] / 1e6).toFixed(2).padEnd(53)} ║`);
  console.log(`║  AETH:       ${(tokenBalances['AETH'] / 1e6).toFixed(2).padEnd(53)} ║`);
  console.log('╚' + '═'.repeat(68) + '╝');
  console.log();

  const allocations: Array<{ 
    agentId: string; 
    sol: number;
    agentUsdc: number;
    agentBtc: number;
    agentSol: number;
    agentEth: number;
  }> = [];
  
  let remainingSol = solBalanceFormatted;
  let remainingUsdc = tokenBalances['AUSDC'] / 1e6;
  let remainingBtc = tokenBalances['ABTC'] / 1e6;
  let remainingAgentSol = tokenBalances['ASOL'] / 1e6;
  let remainingEth = tokenBalances['AETH'] / 1e6;

  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i];
    
    console.log();
    console.log(`--- Funding Agent ${i + 1}: ${agent.name} (${agent.id}) ---`);
    console.log(`Type: ${agent.type}`);
    console.log(`Address: ${agent.publicKey}`);
    console.log();
    console.log('Treasury remaining:');
    console.log(`  SOL:        ${remainingSol.toFixed(4)}`);
    console.log(`  AUSDC:      ${remainingUsdc.toFixed(2)}`);
    console.log(`  ABTC:       ${remainingBtc.toFixed(4)}`);
    console.log(`  ASOL:       ${remainingAgentSol.toFixed(2)}`);
    console.log(`  AETH:       ${remainingEth.toFixed(2)}`);
    console.log();

    // SOL allocation
    const solInput = await ask(`SOL to allocate? (0-${remainingSol.toFixed(4)}): `);
    const solAmount = parseFloat(solInput) || 0;
    if (isNaN(solAmount) || solAmount < 0 || solAmount > remainingSol) {
      console.error('✗ Invalid SOL amount');
      i--;
      continue;
    }
    remainingSol -= solAmount;

    // AUSDC allocation
    const usdcInput = await ask(`AUSDC to allocate? (0-${remainingUsdc.toFixed(2)}): `);
    const usdcAmount = parseFloat(usdcInput) || 0;
    if (isNaN(usdcAmount) || usdcAmount < 0 || usdcAmount > remainingUsdc) {
      console.error('✗ Invalid AUSDC amount');
      i--;
      continue;
    }
    remainingUsdc -= usdcAmount;

    // ABTC allocation
    const btcInput = await ask(`ABTC to allocate? (0-${remainingBtc.toFixed(4)}): `);
    const btcAmount = parseFloat(btcInput) || 0;
    if (isNaN(btcAmount) || btcAmount < 0 || btcAmount > remainingBtc) {
      console.error('✗ Invalid ABTC amount');
      i--;
      continue;
    }
    remainingBtc -= btcAmount;

    // ASOL allocation
    const agentSolInput = await ask(`ASOL to allocate? (0-${remainingAgentSol.toFixed(2)}): `);
    const agentSolAmount = parseFloat(agentSolInput) || 0;
    if (isNaN(agentSolAmount) || agentSolAmount < 0 || agentSolAmount > remainingAgentSol) {
      console.error('✗ Invalid ASOL amount');
      i--;
      continue;
    }
    remainingAgentSol -= agentSolAmount;

    // AETH allocation
    const ethInput = await ask(`AETH to allocate? (0-${remainingEth.toFixed(2)}): `);
    const ethAmount = parseFloat(ethInput) || 0;
    if (isNaN(ethAmount) || ethAmount < 0 || ethAmount > remainingEth) {
      console.error('✗ Invalid AETH amount');
      i--;
      continue;
    }
    remainingEth -= ethAmount;

    allocations.push({
      agentId: agent.id,
      sol: solAmount,
      agentUsdc: usdcAmount,
      agentBtc: btcAmount,
      agentSol: agentSolAmount,
      agentEth: ethAmount,
    });

    console.log(`✓ Allocation set for ${agent.name}`);
  }

  console.log();
  console.log('='.repeat(70));
  console.log('FUNDING SUMMARY');
  console.log('='.repeat(70));
  console.log();

  allocations.forEach((alloc, i) => {
    console.log(`${i + 1}. ${agents[i].name}`);
    console.log(`   SOL:        ${alloc.sol}`);
    console.log(`   AUSDC:      ${alloc.agentUsdc}`);
    console.log(`   ABTC:       ${alloc.agentBtc}`);
    console.log(`   ASOL:       ${alloc.agentSol}`);
    console.log(`   AETH:       ${alloc.agentEth}`);
    console.log();
  });

  const confirm = await ask('Proceed with funding? (yes/no): ');
  if (confirm.toLowerCase() !== 'yes') {
    console.log('Cancelled.');
    rl.close();
    process.exit(0);
  }

  console.log();
  console.log('Executing transfers...');
  console.log();

  for (let i = 0; i < allocations.length; i++) {
    const alloc = allocations[i];
    const agent = agents[i];

    console.log(`Funding ${agent.name}...`);

    // Transfer SOL
    if (alloc.sol > 0) {
      try {
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: treasuryKeypair.publicKey,
            toPubkey: new PublicKey(agent.publicKey),
            lamports: alloc.sol * LAMPORTS_PER_SOL,
          })
        );
        const signature = await sendAndConfirmTransaction(connection, tx, [treasuryKeypair]);
        console.log(`  ✓ SOL: ${alloc.sol} transferred`);
        console.log(`    Tx: ${signature.slice(0, 40)}...`);
      } catch (error: any) {
        console.error(`  ✗ SOL transfer failed: ${error.message.slice(0, 60)}`);
      }
    }

    // Transfer AUSDC
    if (alloc.agentUsdc > 0) {
      const sig = await transferToken(
        connection,
        treasuryKeypair,
        agent.publicKey,
        AGENT_TOKENS.AUSDC,
        alloc.agentUsdc,
        TOKEN_DECIMALS[AGENT_TOKENS.AUSDC]
      );
      if (sig) {
        console.log(`  ✓ AUSDC: ${alloc.agentUsdc} transferred`);
        console.log(`    Tx: ${sig.slice(0, 40)}...`);
      }
    }

    // Transfer ABTC
    if (alloc.agentBtc > 0) {
      const sig = await transferToken(
        connection,
        treasuryKeypair,
        agent.publicKey,
        AGENT_TOKENS.ABTC,
        alloc.agentBtc,
        TOKEN_DECIMALS[AGENT_TOKENS.ABTC]
      );
      if (sig) {
        console.log(`  ✓ ABTC: ${alloc.agentBtc} transferred`);
        console.log(`    Tx: ${sig.slice(0, 40)}...`);
      }
    }

    // Transfer ASOL
    if (alloc.agentSol > 0) {
      const sig = await transferToken(
        connection,
        treasuryKeypair,
        agent.publicKey,
        AGENT_TOKENS.ASOL,
        alloc.agentSol,
        TOKEN_DECIMALS[AGENT_TOKENS.ASOL]
      );
      if (sig) {
        console.log(`  ✓ ASOL: ${alloc.agentSol} transferred`);
        console.log(`    Tx: ${sig.slice(0, 40)}...`);
      }
    }

    // Transfer AETH
    if (alloc.agentEth > 0) {
      const sig = await transferToken(
        connection,
        treasuryKeypair,
        agent.publicKey,
        AGENT_TOKENS.AETH,
        alloc.agentEth,
        TOKEN_DECIMALS[AGENT_TOKENS.AETH]
      );
      if (sig) {
        console.log(`  ✓ AETH: ${alloc.agentEth} transferred`);
        console.log(`    Tx: ${sig.slice(0, 40)}...`);
      }
    }
  }

  console.log();
  console.log('Final Agent Balances:');
  console.log('-'.repeat(70));

  for (const agent of agents) {
    try {
      const pubkey = new PublicKey(agent.publicKey);
      const solBalance = await connection.getBalance(pubkey);
      const usdcBalance = await getTokenBalance(connection, pubkey, AGENT_TOKENS.AUSDC);
      const btcBalance = await getTokenBalance(connection, pubkey, AGENT_TOKENS.ABTC);
      const solTokenBalance = await getTokenBalance(connection, pubkey, AGENT_TOKENS.ASOL);
      const ethBalance = await getTokenBalance(connection, pubkey, AGENT_TOKENS.AETH);

      console.log(`${agent.name}:`);
      console.log(`  SOL:        ${(solBalance / LAMPORTS_PER_SOL).toFixed(4)}`);
      console.log(`  AUSDC:      ${(usdcBalance / 1e6).toFixed(2)}`);
      console.log(`  ABTC:       ${(btcBalance / 1e6).toFixed(4)}`);
      console.log(`  ASOL:       ${(solTokenBalance / 1e6).toFixed(2)}`);
      console.log(`  AETH:       ${(ethBalance / 1e6).toFixed(2)}`);
      console.log();
    } catch {
      console.log(`${agent.name}: Error checking balance`);
    }
  }

  console.log();
  console.log('='.repeat(70));
  console.log('✓ Funding complete!');
  console.log('='.repeat(70));
  console.log();

  rl.close();
}

main().catch(error => {
  console.error('Error:', error);
  rl.close();
  process.exit(1);
});
