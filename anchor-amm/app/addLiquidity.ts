/**
 * Add Liquidity to Existing Pool
 * 
 * Run: npx ts-node addLiquidity.ts <TOKEN> <SOL_AMOUNT>
 * Example: npx ts-node addLiquidity.ts AGENTUSDC 5
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, Wallet, BN } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import dotenv from 'dotenv';
dotenv.config();
const IDL: any = require("./idl.json");
const PROGRAM_ID = new PublicKey("5LU3snhGuiRYF1u1W3cX8xUYoPbNYiZHKPQgqZgxQJi6");
const NETWORK = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';

const TOKEN_CONFIGS: Record<string, { mint: string; decimals: number; priceInSol: number }> = {
  AGENTUSDC: { mint: "3PB7QgKc5iUb8sgCpyzkTxUxKAfvcLPhMtqRuKZ64puN", decimals: 6, priceInSol: 0.000025 },
  AGENTBTC: { mint: "2FNb28koXRYT3SPgG3GgCoFsH1qfYdpwx5qXo9q9pH1Q", decimals: 8, priceInSol: 0.0025 },
  AGENTETH: { mint: "Cvn7fQLsjCbdBXUiQecxDvonZfiCShgNZvCcuuAraPV1", decimals: 8, priceInSol: 0.0005 },
  AGENTSOL: { mint: "HyE12sVYwimSFMUQnc4AKp3TkPFKjumUhLNs4YwzngsZ", decimals: 9, priceInSol: 0.05 },
};

interface PoolConfig {
  tokenSymbol: string;
  poolId: string;
  vaultA: string;
  vaultB: string;
  mintA: string;
  mintB: string;
  decimalsA: number;
  decimalsB: number;
}

async function addLiquidity(tokenSymbol: string, solAmount: number) {
  const config = TOKEN_CONFIGS[tokenSymbol];
  if (!config) throw new Error(`Unknown token: ${tokenSymbol}`);

  // Load treasury
  const keypairPath = path.resolve(__dirname, "../../treasury-keypair.json");
  const secretKey: number[] = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  const wallet = Keypair.fromSecretKey(new Uint8Array(secretKey));

  const connection = new Connection(NETWORK, "confirmed");
  
  // Load pool config
  const poolPath = path.resolve(__dirname, "../../pool-configs.json");
  const pools: Record<string, PoolConfig> = JSON.parse(fs.readFileSync(poolPath, "utf-8"));
  const pool = pools[tokenSymbol];
  if (!pool) throw new Error(`Pool for ${tokenSymbol} not found`);

  console.log(`\n💧 Adding liquidity to ${tokenSymbol}/SOL pool...`);
  console.log(`   Adding: ${solAmount} SOL`);
  
  // Calculate token amount based on current price ratio
  const tokenAmount = solAmount / config.priceInSol;
  console.log(`   Adding: ${tokenAmount.toLocaleString()} ${tokenSymbol}`);

  const mintA = new PublicKey(config.mint);
  const poolPda = new PublicKey(pool.poolId);
  const vaultA = new PublicKey(pool.vaultA);
  const vaultB = new PublicKey(pool.vaultB);

  // Setup provider
  const anchorWallet = new Wallet(wallet);
  const provider = new AnchorProvider(connection, anchorWallet, { commitment: "confirmed" });
  anchor.setProvider(provider);
  const program: Program<any> = new Program(IDL, provider);

  // Get or create token accounts
  const userTokenA = await getOrCreateAssociatedTokenAccount(connection, wallet, mintA, wallet.publicKey);
  const userTokenB = await getOrCreateAssociatedTokenAccount(connection, wallet, NATIVE_MINT, wallet.publicKey);

  // Wrap SOL
  console.log("   Wrapping SOL...");
  const wrapTx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, userTokenB.address, wallet.publicKey, NATIVE_MINT),
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: userTokenB.address,
      lamports: Math.floor(solAmount * LAMPORTS_PER_SOL),
    }),
    createSyncNativeInstruction(userTokenB.address)
  );
  await sendAndConfirmTransaction(connection, wrapTx, [wallet]);

  // Add liquidity
  const amountA = new BN(Math.floor(tokenAmount * 10 ** config.decimals));
  const amountB = new BN(Math.floor(solAmount * LAMPORTS_PER_SOL));

  console.log("   Executing addLiquidity...");
  const tx: string = await (program.methods as any)
    .addLiquidity(amountA, amountB)
    .accounts({
      user: wallet.publicKey,
      pool: poolPda,
      userTokenA: userTokenA.address,
      userTokenB: userTokenB.address,
      vaultA: vaultA,
      vaultB: vaultB,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([wallet])
    .rpc();

  console.log(`✅ Liquidity added!`);
  console.log(`   TX: ${tx}`);
}

async function main(): Promise<void> {
  const tokenSymbol = process.argv[2]?.toUpperCase();
  const solAmount = parseFloat(process.argv[3] || "");

  if (!tokenSymbol || !solAmount || !TOKEN_CONFIGS[tokenSymbol]) {
    console.error("Usage: npx ts-node addLiquidity.ts <TOKEN> <SOL_AMOUNT>");
    console.error("Example: npx ts-node addLiquidity.ts AGENTUSDC 5");
    process.exit(1);
  }

  await addLiquidity(tokenSymbol, solAmount);
}

main().catch(console.error);
