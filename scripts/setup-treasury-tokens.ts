#!/usr/bin/env ts-node
/**
 * Setup Treasury Tokens
 * 
 * After creating treasury, this script:
 * 1. Requests devnet SOL for treasury (airdrop)
 * 2. Treasury buys all 4 Agent Mesh tokens from pools
 * 
 * This gives judges everything they need to fund agents.
 * 
 * Usage: npx ts-node scripts/setup-treasury-tokens.ts
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
  getAssociatedTokenAddressSync, 
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  createSyncNativeInstruction,
} from '@solana/spl-token';
import fs from 'fs';
import dotenv from 'dotenv';
import * as anchor from '@coral-xyz/anchor';
import { Program, AnchorProvider, Wallet, BN } from '@coral-xyz/anchor';
import { NETWORK, TREASURY } from '../src/config';
import { decryptKeypair, isValidEncryptionKey } from '../src/utils/encryption';
import * as path from 'path';

dotenv.config();

// Token purchase amounts (in SOL worth) - TOTAL 0.5 SOL
const TOKEN_PURCHASES = [
  { symbol: 'AUSDC', solAmount: 0.125 },   // 0.125 SOL worth
  { symbol: 'ABTC', solAmount: 0.125 },    // 0.125 SOL worth
  { symbol: 'AETH', solAmount: 0.125 },    // 0.125 SOL worth
  { symbol: 'ASOL', solAmount: 0.125 },    // 0.125 SOL worth
];

const MINIMUM_SOL_REQUIRED = 2; // Need ~1.5 SOL for purchases + fees

console.log('='.repeat(70));
console.log('  SETUP TREASURY TOKENS');
console.log('='.repeat(70));
console.log();

async function loadTreasuryKeypair(): Promise<Keypair | null> {
  if (!fs.existsSync(TREASURY.KEYPAIR_PATH)) {
    console.error(`❌ Treasury not found: ${TREASURY.KEYPAIR_PATH}`);
    console.log('Run: npm run generate-treasury first');
    return null;
  }

  const encryptionKey = process.env.WALLET_ENCRYPTION_KEY;
  if (!encryptionKey || !isValidEncryptionKey(encryptionKey)) {
    console.error('❌ WALLET_ENCRYPTION_KEY not set or invalid');
    return null;
  }

  try {
    const encrypted = JSON.parse(fs.readFileSync(TREASURY.KEYPAIR_PATH, 'utf-8'));
    const secretKey = decryptKeypair(encrypted, encryptionKey);
    return Keypair.fromSecretKey(secretKey);
  } catch (e: any) {
    console.error('❌ Failed to decrypt treasury:', e.message);
    return null;
  }
}

async function wrapSol(connection: Connection, wallet: Keypair, amountSol: number): Promise<void> {
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey);
  const amountLamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, wsolAta, wallet.publicKey, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: wsolAta, lamports: amountLamports }),
    createSyncNativeInstruction(wsolAta)
  );

  await sendAndConfirmTransaction(connection, tx, [wallet]);
  console.log(`   Wrapped ${amountSol} SOL for trading`);
}

async function requestAirdrop(connection: Connection, treasuryKeypair: Keypair): Promise<boolean> {
  console.log('💧 Requesting devnet SOL airdrop...');
  console.log(`   Treasury: ${treasuryKeypair.publicKey.toString()}`);
  console.log();

  const balanceBefore = await connection.getBalance(treasuryKeypair.publicKey);
  console.log(`   Balance before: ${(balanceBefore / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  if (balanceBefore >= MINIMUM_SOL_REQUIRED * LAMPORTS_PER_SOL) {
    console.log('   ✅ Treasury already has sufficient SOL');
    return true;
  }

  // Request airdrop (max 5 SOL per request on devnet)
  const needed = Math.ceil((MINIMUM_SOL_REQUIRED * LAMPORTS_PER_SOL - balanceBefore) / LAMPORTS_PER_SOL);
  const requests = Math.min(4, Math.ceil(needed / 5)); // Max 4 requests (20 SOL)

  for (let i = 0; i < requests; i++) {
    try {
      console.log(`   Requesting airdrop ${i + 1}/${requests}...`);
      const signature = await connection.requestAirdrop(
        treasuryKeypair.publicKey,
        5 * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(signature);
      console.log(`   ✓ Airdrop confirmed: ${signature.slice(0, 40)}...`);
    } catch (e: any) {
      console.error(`   ✗ Airdrop failed: ${e.message}`);
      console.log();
      console.log('⚠️  Could not get enough SOL from faucet.');
      console.log('   Please request manually:');
      console.log(`   https://faucet.solana.com/?address=${treasuryKeypair.publicKey.toString()}`);
      return false;
    }
    
    // Rate limit
    await new Promise(r => setTimeout(r, 2000));
  }

  const balanceAfter = await connection.getBalance(treasuryKeypair.publicKey);
  console.log(`   Balance after: ${(balanceAfter / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  console.log();

  return balanceAfter >= MINIMUM_SOL_REQUIRED * LAMPORTS_PER_SOL * 0.5; // At least 50%
}

async function ensureTokenAccount(
  connection: Connection,
  wallet: Keypair,
  mint: PublicKey
): Promise<void> {
  try {
    const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey);
    
    // Ensure ATA exists
    try {
      await connection.getTokenAccountBalance(ata);
      return; // Already exists
    } catch {
      // Need to create it
    }
    
    console.log(`   Creating token account for ${mint.toString().slice(0, 8)}...`);
    
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey,
        ata,
        wallet.publicKey,
        mint
      )
    );
    
    await sendAndConfirmTransaction(connection, tx, [wallet]);
    console.log(`   ✅ Token account created`);
  } catch (e: any) {
    console.log(`   ⚠️ Token account may already exist: ${e.message.slice(0, 50)}`);
  }
}

async function buyTokenFromPool(
  connection: Connection,
  treasuryKeypair: Keypair,
  poolConfig: any,
  solAmount: number,
  program: Program<any>
): Promise<boolean> {
  try {
    console.log(`   Buying ${poolConfig.tokenSymbol} with ${solAmount} SOL...`);

    const poolPda = new PublicKey(poolConfig.poolId);
    const mintA = new PublicKey(poolConfig.mintA);
    
    const userTokenA = getAssociatedTokenAddressSync(mintA, treasuryKeypair.publicKey);
    const userTokenB = getAssociatedTokenAddressSync(NATIVE_MINT, treasuryKeypair.publicKey);

    // Step 1: Ensure token account exists (for receiving purchased tokens)
    await ensureTokenAccount(connection, treasuryKeypair, mintA);

    // Step 2: Wrap SOL first
    await wrapSol(connection, treasuryKeypair, solAmount * 1.02);

    // Step 3: Execute swap: SOL -> Token (B_TO_A = false)
    const amountInRaw = new BN(Math.floor(solAmount * LAMPORTS_PER_SOL));
    
    const tx = await (program.methods as any)
      .swap(amountInRaw, new BN(0), false)
      .accounts({
        user: treasuryKeypair.publicKey,
        pool: poolPda,
        userTokenA,
        userTokenB,
        vaultA: new PublicKey(poolConfig.vaultA),
        vaultB: new PublicKey(poolConfig.vaultB),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([treasuryKeypair])
      .rpc();

    console.log(`   ✅ Bought ${poolConfig.tokenSymbol}`);
    console.log(`   TX: ${tx.slice(0, 50)}...`);
    return true;

  } catch (e: any) {
    console.error(`   ❌ Failed to buy ${poolConfig.tokenSymbol}: ${e.message.slice(0, 80)}`);
    return false;
  }
}

async function main() {
  // Load treasury
  const treasuryKeypair = await loadTreasuryKeypair();
  if (!treasuryKeypair) {
    process.exit(1);
  }

  console.log('Treasury:', treasuryKeypair.publicKey.toString());
  console.log();

  const connection = new Connection(NETWORK.RPC_URL, 'confirmed');

  // Validate pools
  const poolPath = path.resolve(process.cwd(), 'pool-configs.json');
  if (!fs.existsSync(poolPath)) {
    console.error('❌ Pool configs not found. Pools must be created first.');
    console.log('   The Agent Mesh pools should already exist on devnet.');
    console.log('   Check pool-configs.json for pool addresses.');
    process.exit(1);
  }

  const pools: Record<string, any> = JSON.parse(fs.readFileSync(poolPath, 'utf-8'));

  // Step 1: Get SOL
  const hasSol = await requestAirdrop(connection, treasuryKeypair);
  if (!hasSol) {
    console.log();
    console.log('Cannot continue without SOL. Please fund treasury manually.');
    process.exit(1);
  }

  // Step 2: Initialize AMM program
  console.log('🔧 Initializing AMM connection...');
  const anchorWallet = new Wallet(treasuryKeypair);
  const provider = new AnchorProvider(connection, anchorWallet, { commitment: 'confirmed' });
  const idl = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'anchor-amm/app/idl.json'), 'utf-8'));
  const program = new Program(idl, provider);
  console.log('   ✅ AMM connected');
  console.log();

  // Step 3: Buy tokens
  console.log('💰 Purchasing tokens from pools...');
  console.log();

  for (const purchase of TOKEN_PURCHASES) {
    const pool = pools[purchase.symbol];
    if (!pool) {
      console.log(`   ⚠️ Pool not found for ${purchase.symbol}`);
      continue;
    }

    await buyTokenFromPool(connection, treasuryKeypair, pool, purchase.solAmount, program);
    
    // Rate limit
    await new Promise(r => setTimeout(r, 3000));
  }

  // Step 4: Show final balances
  console.log();
  console.log('='.repeat(70));
  console.log('TREASURY HOLDINGS');
  console.log('='.repeat(70));
  console.log();

  const solBalance = await connection.getBalance(treasuryKeypair.publicKey);
  console.log(`SOL:  ${(solBalance / LAMPORTS_PER_SOL).toFixed(4)}`);

  for (const symbol of ['AUSDC', 'ABTC', 'AETH', 'ASOL']) {
    try {
      const pool = pools[symbol];
      if (!pool) continue;
      
      const mint = new PublicKey(pool.mintA);
      const ata = getAssociatedTokenAddressSync(mint, treasuryKeypair.publicKey);
      const balance = await connection.getTokenAccountBalance(ata);
      const amount = Number(balance.value.amount) / 10 ** pool.decimalsA;
      console.log(`${symbol}: ${amount.toFixed(4)}`);
    } catch {
      console.log(`${symbol}: 0 (no account)`);
    }
  }

  console.log();
  console.log('='.repeat(70));
  console.log('✅ Treasury setup complete!');
  console.log('='.repeat(70));
  console.log();
  console.log('Next steps:');
  console.log('   npm run init-interactive  # Create agent wallets');
  console.log('   npm run fund-interactive  # Fund agents from treasury');
  console.log('   npm run swarm             # Start trading');
  console.log();
}

main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
