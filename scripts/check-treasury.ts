#!/usr/bin/env ts-node
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const KEYPAIR_PATH = process.env.TREASURY_KEYPAIR_PATH || './treasury-keypair.json';

async function main() {
  if (!fs.existsSync(KEYPAIR_PATH)) {
    console.error('Treasury keypair not found. Run: npm run generate-treasury');
    process.exit(1);
  }

  const secretKey = new Uint8Array(JSON.parse(fs.readFileSync(KEYPAIR_PATH, 'utf-8')));
  const keypair = Keypair.fromSecretKey(secretKey);
  const connection = new Connection(RPC_URL, 'confirmed');

  const balance = await connection.getBalance(keypair.publicKey);
  console.log('Treasury:', keypair.publicKey.toString());
  console.log('Balance:', (balance / LAMPORTS_PER_SOL).toFixed(4), 'SOL');
}

main().catch(console.error);
