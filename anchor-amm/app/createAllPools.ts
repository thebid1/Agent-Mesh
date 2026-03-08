/**
 * Create all 4 AMM pools for AGENT tokens
 * Total: 10 SOL (2.5 per pool)
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

interface PoolDef {
  symbol: string;
  mint: string;
  decimals: number;
  tokens: number;
  sol: number;
}

const POOLS: PoolDef[] = [
  { symbol: "AGENTUSDC", mint: "3PB7QgKc5iUb8sgCpyzkTxUxKAfvcLPhMtqRuKZ64puN", decimals: 6, tokens: 100_000, sol: 2.5 },
  { symbol: "AGENTBTC", mint: "2FNb28koXRYT3SPgG3GgCoFsH1qfYdpwx5qXo9q9pH1Q", decimals: 8, tokens: 1_000, sol: 2.5 },
  { symbol: "AGENTETH", mint: "Cvn7fQLsjCbdBXUiQecxDvonZfiCShgNZvCcuuAraPV1", decimals: 8, tokens: 5_000, sol: 2.5 },
  { symbol: "AGENTSOL", mint: "HyE12sVYwimSFMUQnc4AKp3TkPFKjumUhLNs4YwzngsZ", decimals: 9, tokens: 50, sol: 2.5 },
];

interface PoolConfig {
  tokenSymbol: string;
  poolId: string;
  vaultA: string;
  vaultB: string;
  mintA: string;
  mintB: string;
  decimalsA: number;
  decimalsB: number;
  createdAt: string;
}

async function createPool(
  connection: Connection,
  program: Program<any>,
  wallet: Keypair,
  poolDef: PoolDef
): Promise<PoolConfig> {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Creating ${poolDef.symbol}/SOL Pool`);
  console.log(`${"=".repeat(60)}`);
  console.log(`Token: ${poolDef.mint}`);
  console.log(`Initial: ${poolDef.tokens} ${poolDef.symbol} + ${poolDef.sol} SOL`);

  const mintA = new PublicKey(poolDef.mint);
  const mintB = NATIVE_MINT;

  // Derive PDAs
  const [poolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), mintA.toBuffer(), mintB.toBuffer()],
    PROGRAM_ID
  );
  const [vaultA] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_a"), poolPda.toBuffer()],
    PROGRAM_ID
  );
  const [vaultB] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_b"), poolPda.toBuffer()],
    PROGRAM_ID
  );

  console.log(`Pool: ${poolPda.toBase58().slice(0, 20)}...`);

  // Check if exists
  const poolAccount = await connection.getAccountInfo(poolPda);
  if (poolAccount) {
    console.log("⚠️  Pool already exists, skipping...");
    return {
      tokenSymbol: poolDef.symbol,
      poolId: poolPda.toBase58(),
      vaultA: vaultA.toBase58(),
      vaultB: vaultB.toBase58(),
      mintA: mintA.toBase58(),
      mintB: mintB.toBase58(),
      decimalsA: poolDef.decimals,
      decimalsB: 9,
      createdAt: new Date().toISOString(),
    };
  }

  // Initialize pool
  console.log("📦 Initializing pool...");
  const initTx: string = await (program.methods as any)
    .initializePool()
    .accounts({
      authority: wallet.publicKey,
      pool: poolPda,
      mintA: mintA,
      mintB: mintB,
      vaultA: vaultA,
      vaultB: vaultB,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([wallet])
    .rpc();
  console.log(`✅ Initialized: ${initTx.slice(0, 40)}...`);

  // Setup token accounts
  console.log("💧 Adding liquidity...");
  const userTokenA = await getOrCreateAssociatedTokenAccount(connection, wallet, mintA, wallet.publicKey);
  const userTokenB = await getOrCreateAssociatedTokenAccount(connection, wallet, mintB, wallet.publicKey);

  // Wrap SOL
  const wrapTx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, userTokenB.address, wallet.publicKey, NATIVE_MINT),
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: userTokenB.address,
      lamports: Math.floor(poolDef.sol * LAMPORTS_PER_SOL),
    }),
    createSyncNativeInstruction(userTokenB.address)
  );
  await sendAndConfirmTransaction(connection, wrapTx, [wallet]);

  // Add liquidity
  const amountA = new BN(poolDef.tokens * 10 ** poolDef.decimals);
  const amountB = new BN(Math.floor(poolDef.sol * LAMPORTS_PER_SOL));

  const liqTx: string = await (program.methods as any)
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
  console.log(`✅ Liquidity added: ${liqTx.slice(0, 40)}...`);

  return {
    tokenSymbol: poolDef.symbol,
    poolId: poolPda.toBase58(),
    vaultA: vaultA.toBase58(),
    vaultB: vaultB.toBase58(),
    mintA: mintA.toBase58(),
    mintB: mintB.toBase58(),
    decimalsA: poolDef.decimals,
    decimalsB: 9,
    createdAt: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  // Load treasury
  const keypairPath = path.resolve(__dirname, "../../treasury-keypair.json");
  const secretKey: number[] = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  const wallet = Keypair.fromSecretKey(new Uint8Array(secretKey));

  const connection = new Connection(NETWORK, "confirmed");
  const balance = await connection.getBalance(wallet.publicKey);
  const solBalance = balance / LAMPORTS_PER_SOL;

  console.log(`Treasury: ${wallet.publicKey.toBase58()}`);
  console.log(`Balance: ${solBalance.toFixed(4)} SOL`);

  const requiredSol = POOLS.reduce((sum, p) => sum + p.sol, 0);
  console.log(`Required: ${requiredSol} SOL`);

  if (solBalance < requiredSol) {
    console.error(`\n❌ Insufficient SOL!`);
    console.error(`Need ${requiredSol} SOL, have ${solBalance.toFixed(4)} SOL`);
    console.error(`\nAirdrop more:`);
    console.error(`solana airdrop 5 ${wallet.publicKey.toBase58()} --url devnet`);
    process.exit(1);
  }

  // Setup program
  const anchorWallet = new Wallet(wallet);
  const provider = new AnchorProvider(connection, anchorWallet, { commitment: "confirmed" });
  anchor.setProvider(provider);
  const program: Program<any> = new Program(IDL, provider);

  // Create all pools
  const configs: Record<string, PoolConfig> = {};

  for (const poolDef of POOLS) {
    try {
      const config = await createPool(connection, program, wallet, poolDef);
      configs[poolDef.symbol] = config;
    } catch (error: any) {
      console.error(`\n❌ Failed to create ${poolDef.symbol} pool:`, error.message);
      console.log("Continuing with remaining pools...");
    }
  }

  // Save configs
  const configPath = path.resolve(__dirname, "../../pool-configs.json");
  fs.writeFileSync(configPath, JSON.stringify(configs, null, 2));
  console.log(`\n${"=".repeat(60)}`);
  console.log(`✅ All pools created!`);
  console.log(`Config saved to: pool-configs.json`);
  console.log(`${"=".repeat(60)}`);

  // Summary
  for (const [symbol, config] of Object.entries(configs)) {
    console.log(`\n${symbol}:`);
    console.log(`  Pool: ${config.poolId}`);
    console.log(`  Vaults: ${config.vaultA.slice(0, 20)}... / ${config.vaultB.slice(0, 20)}...`);
  }
}

main().catch(console.error);
