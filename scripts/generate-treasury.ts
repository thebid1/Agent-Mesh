#!/usr/bin/env ts-node
/**
 * Treasury Keypair Generator (Encrypted)
 * 
 * Run this to create a new encrypted treasury wallet for funding agents.
 * Automatically generates and saves encryption key to .env
 * 
 * SAFETY FEATURES:
 * - Refuses to overwrite existing treasury without explicit confirmation
 * - Auto-creates backups before any changes
 * - Validates encryption key format
 * 
 * Usage: npx ts-node scripts/generate-treasury.ts
 */

import { Keypair } from '@solana/web3.js';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import dotenv from 'dotenv';
import { encryptKeypair, generateEncryptionKey, isValidEncryptionKey } from '../src/utils/encryption';

dotenv.config();

const KEYPAIR_PATH = process.argv[2] || './treasury-keypair.enc.json';
const ENV_PATH = './.env';
const BACKUP_DIR = './backups';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function ask(question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve));
}

function createBackup(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = path.basename(filePath);
  const backupPath = path.join(BACKUP_DIR, `${fileName}.${timestamp}.backup`);
  
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

async function main() {
  console.log('='.repeat(70));
  console.log('  AGENT MESH - Treasury Keypair Generator (Encrypted)');
  console.log('='.repeat(70));
  console.log();
  
  // SAFETY CHECK 1: Check if treasury already exists
  if (fs.existsSync(KEYPAIR_PATH)) {
    console.log('⚠️  WARNING: Treasury keypair already exists!');
    console.log(`   File: ${KEYPAIR_PATH}`);
    
    // Try to show existing public key
    try {
      const { decryptKeypair } = await import('../src/utils/encryption');
      const existingEncryptionKey = process.env.WALLET_ENCRYPTION_KEY;
      if (existingEncryptionKey && isValidEncryptionKey(existingEncryptionKey)) {
        const encryptedData = JSON.parse(fs.readFileSync(KEYPAIR_PATH, 'utf-8'));
        const secretKey = decryptKeypair(encryptedData, existingEncryptionKey);
        const existingKeypair = Keypair.fromSecretKey(secretKey);
        console.log(`   Existing Public Key: ${existingKeypair.publicKey.toString()}`);
      }
    } catch {
      console.log('   (Cannot decrypt - encryption key may have changed)');
    }
    
    console.log();
    console.log('🔴 Creating a new treasury will:');
    console.log('   1. BACKUP the existing treasury file');
    console.log('   2. Create a NEW treasury (different public key)');
    console.log('   3. Any funds on the OLD treasury will be LOST unless backed up!');
    console.log();
    
    const confirm = await ask('❓ Are you sure you want to create a new treasury? (type "yes overwrite" to confirm): ');
    
    if (confirm !== 'yes overwrite') {
      console.log();
      console.log('✅ Cancelled. Existing treasury preserved.');
      console.log();
      console.log('To use the existing treasury:');
      console.log('  1. Ensure WALLET_ENCRYPTION_KEY is set in .env');
      console.log('  2. Run: npx ts-node scripts/check-treasury.ts');
      rl.close();
      process.exit(0);
    }
    
    console.log();
    console.log('Creating backup of existing treasury...');
    const backupPath = createBackup(KEYPAIR_PATH);
    if (backupPath) {
      console.log(`✅ Backup created: ${backupPath}`);
    }
    
    // Also backup .env
    const envBackup = createBackup(ENV_PATH);
    if (envBackup) {
      console.log(`✅ Backup created: ${envBackup}`);
    }
    console.log();
  }
  
  // Check for encryption key
  let encryptionKey = process.env.WALLET_ENCRYPTION_KEY;
  let keyWasGenerated = false;
  
  if (!encryptionKey) {
    console.log('🔐 Generating new encryption key...');
    console.log();
    
    encryptionKey = generateEncryptionKey();
    keyWasGenerated = true;
    
    // Auto-save to .env
    let envContent = '';
    if (fs.existsSync(ENV_PATH)) {
      envContent = fs.readFileSync(ENV_PATH, 'utf-8');
    }
    
    // Backup original .env
    const envBackup = createBackup(ENV_PATH);
    
    // Prevent duplicate env vars
    if (envContent.includes('WALLET_ENCRYPTION_KEY=')) {
      // Replace existing key
      envContent = envContent.replace(
        /WALLET_ENCRYPTION_KEY=.*/,
        `WALLET_ENCRYPTION_KEY=${encryptionKey}`
      );
    } else {
      // Add new key at the top
      envContent = `# Wallet Encryption (REQUIRED)\n# Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"\nWALLET_ENCRYPTION_KEY=${encryptionKey}\n\n${envContent}`;
    }
    
    fs.writeFileSync(ENV_PATH, envContent);
    console.log('✅ Encryption key auto-saved to .env');
    if (envBackup) {
      console.log(`   (Previous .env backed up to: ${envBackup})`);
    }
    console.log();
    console.log('🔐 Your Encryption Key:');
    console.log(encryptionKey);
    console.log();
    console.log('⚠️  IMPORTANT: BACKUP this key securely!');
    console.log('   Without it, your wallets are UNRECOVERABLE!');
    console.log();
  }
  
  if (!isValidEncryptionKey(encryptionKey)) {
    console.error('✗ Invalid WALLET_ENCRYPTION_KEY. Must be 64 hex characters.');
    rl.close();
    process.exit(1);
  }
  
  // Generate new keypair
  console.log('Generating new treasury keypair...');
  const keypair = Keypair.generate();
  
  console.log();
  console.log('✓ New treasury keypair generated!');
  console.log();
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  PUBLIC KEY (Address):');
  console.log(`  ${keypair.publicKey.toString()}`);
  console.log('══════════════════════════════════════════════════════════════════');
  console.log();
  console.log('📝 NEXT STEPS:');
  console.log();
  console.log('1️⃣  Fund this address with devnet SOL:');
  console.log(`    https://faucet.solana.com/?address=${keypair.publicKey.toString()}`);
  console.log(`    OR: solana airdrop 5 ${keypair.publicKey.toString()} --url devnet`);
  console.log();
  console.log('2️⃣  After funding, create agents:');
  console.log('    npx ts-node scripts/interactive-init.ts');
  console.log('    OR: npx ts-node scripts/quick-init.ts');
  console.log();
  console.log('3️⃣  Fund your agents:');
  console.log('    npx ts-node scripts/interactive-fund.ts');
  console.log();
  
  // Encrypt and save keypair
  const encryptedData = encryptKeypair(keypair.secretKey, encryptionKey);
  const fullPath = path.resolve(KEYPAIR_PATH);
  
  fs.writeFileSync(fullPath, JSON.stringify(encryptedData, null, 2));
  console.log(`💾 Encrypted keypair saved to: ${fullPath}`);
  console.log();
  
  // Update .env with treasury path if needed
  let envContent = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf-8') : '';
  if (!envContent.includes('TREASURY_KEYPAIR_PATH=')) {
    envContent += `\nTREASURY_KEYPAIR_PATH=${fullPath}\n`;
    fs.writeFileSync(ENV_PATH, envContent);
    console.log(`✅ TREASURY_KEYPAIR_PATH added to .env`);
  }
  
  // Also create a backup info file (NO secret keys!)
  const infoContent = `
TREASURY WALLET INFO
====================
Generated: ${new Date().toISOString()}
Public Key: ${keypair.publicKey.toString()}
Network: Devnet
Purpose: Agent Mesh Treasury
Encryption: AES-256-GCM

FUNDING INSTRUCTIONS:
1. Visit: https://faucet.solana.com/?address=${keypair.publicKey.toString()}
2. Request devnet SOL (max 10 SOL per request)
3. Repeat until you have enough (recommend 10+ SOL for 4 agents)
4. Or use CLI: solana airdrop 5 ${keypair.publicKey.toString()} --url devnet

SECURITY NOTES:
- This keypair is ENCRYPTED with AES-256-GCM
- The encryption key is in your .env file (WALLET_ENCRYPTION_KEY)
- NEVER commit .env or keypair files to git
- Keep a backup of both the encryption key and the encrypted keypair
- Without the encryption key, the wallet is UNRECOVERABLE
- Auto-backups stored in: ${BACKUP_DIR}/

QUICK START:
npx ts-node scripts/interactive-init.ts  # Create agents
npx ts-node scripts/interactive-fund.ts  # Fund agents
`;
  
  const infoPath = fullPath.replace('.enc.json', '-info.txt');
  fs.writeFileSync(infoPath, infoContent);
  console.log(`📄 Info file saved to: ${infoPath}`);
  console.log();
  console.log('='.repeat(70));
  console.log('✅ Setup complete! Fund your treasury and create agents.');
  console.log('='.repeat(70));
  
  rl.close();
}

main().catch(error => {
  console.error('Error:', error);
  rl.close();
  process.exit(1);
});
