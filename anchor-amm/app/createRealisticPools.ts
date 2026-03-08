/**
 * Create Realistic Pools with Proper Price Ratios
 * 
 * Assumes SOL = $150 for realistic pricing
 * - AGENTUSDC: 150 per SOL ($1 each)
 * - AGENTBTC: 0.00015 per SOL ($100k each)
 * - AGENTETH: 0.003 per SOL ($3k each)
 * - AGENTSOL: 1 per SOL
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

// Realistic pricing (assuming SOL = $150)
const REALISTIC_POOLS = [
  {
    symbol: "AGENTUSDC",
    mint: "3PB7QgKc5iUb8sgCpyzkTxUxKAfvcLPhMtqRuKZ64puN",
    decimals: 6,
    tokensPerSol: 150,        // $1 per token
    initialSol: 5,
  },
  {
    symbol: "AGENTBTC",
    mint: "2FNb28koXRYT3SPgG3GgCoFsH1qfYdpwx5qXo9q9pH1Q",
    decimals: 8,
    tokensPerSol: 0.0015,     // $100k per BTC
    initialSol: 5,
  },
  {
    symbol: "AGENTETH",
    mint: "Cvn7fQLsjCbdBXUiQecxDvonZfiCShgNZvCcuuAraPV1",
    decimals: 8,
    tokensPerSol: 0.05,       // $3k per ETH
    initialSol: 5,
  },
  {
    symbol: "AGENTSOL",
    mint: "HyE12sVYwimSFMUQnc4AKp3TkPFKjumUhLNs4YwzngsZ",
    decimals: 9,
    tokensPerSol: 1,          // 1:1 with SOL
    initialSol: 5,
  },
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
}

async function createPool(wallet: Keypair, program: Program<any>, poolDef: typeof REALISTIC_POOLS[0]): Promise<PoolConfig> {
  console.log(`\n🏊 Creating ${poolDef.symbol}/SOL pool...`);
  console.log(`   Price: 1 SOL = ${poolDef.tokensPerSol} ${poolDef.symbol}`);
  console.log(`   Initial: ${poolDef.tokensPerSol * poolDef.initialSol} ${poolDef.symbol} + ${poolDef.initialSol} SOL`);

  const connection = new Connection(NETWORK, "confirmed");
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

  console.log(`   Pool: ${poolPda.toBase58().slice(0, 20)}...`);

  // Check if exists
  const exists = await connection.getAccountInfo(poolPda);
  if (exists) {
    console.log("   ⚠️  Pool already exists! Skipping...");
    return {
      tokenSymbol: poolDef.symbol,
      poolId: poolPda.toBase58(),
      vaultA: vaultA.toBase58(),
      vaultB: vaultB.toBase58(),
      mintA: mintA.toBase58(),
      mintB: mintB.toBase58(),
      decimalsA: poolDef.decimals,
      decimalsB: 9,
    };
  }

  // Initialize pool
  console.log("   Initializing...");
  await (program.methods as any)
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

  // Calculate token amount
  const tokenAmount = poolDef.tokensPerSol * poolDef.initialSol;

  // Setup accounts
  const userTokenA = await getOrCreateAssociatedTokenAccount(connection, wallet, mintA, wallet.publicKey);
  const userTokenB = await getOrCreateAssociatedTokenAccount(connection, wallet, mintB, wallet.publicKey);

  // Wrap SOL
  const wrapTx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, userTokenB.address, wallet.publicKey, NATIVE_MINT),
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: userTokenB.address,
      lamports: Math.floor(poolDef.initialSol * LAMPORTS_PER_SOL),
    }),
    createSyncNativeInstruction(userTokenB.address)
  );
  await sendAndConfirmTransaction(connection, wrapTx, [wallet]);

  // Add liquidity
  const amountA = new BN(Math.floor(tokenAmount * 10 ** poolDef.decimals));
  const amountB = new BN(Math.floor(poolDef.initialSol * LAMPORTS_PER_SOL));

  console.log("   Adding liquidity...");
  await (program.methods as any)
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

  console.log("   ✅ Pool created!");

  return {
    tokenSymbol: poolDef.symbol,
    poolId: poolPda.toBase58(),
    vaultA: vaultA.toBase58(),
    vaultB: vaultB.toBase58(),
    mintA: mintA.toBase58(),
    mintB: mintB.toBase58(),
    decimalsA: poolDef.decimals,
    decimalsB: 9,
  };
}

async function main(): Promise<void> {
  // Load treasury
  const keypairPath = path.resolve(__dirname, "../../treasury-keypair.json");
  const secretKey: number[] = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  const wallet = Keypair.fromSecretKey(new Uint8Array(secretKey));

  const connection = new Connection(NETWORK, "confirmed");
  const balance = await connection.getBalance(wallet.publicKey);
  
  console.log("=".repeat(60));
  console.log("CREATING REALISTIC POOLS");
  console.log("=".repeat(60));
  console.log(`Treasury: ${wallet.publicKey.toBase58()}`);
  console.log(`Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  const needed = REALISTIC_POOLS.reduce((s, p) => s + p.initialSol, 0);
  console.log(`Needed: ${needed} SOL`);
  
  if (balance < needed * LAMPORTS_PER_SOL) {
    console.error("Insufficient SOL!");
    process.exit(1);
  }

  // Setup program
  const anchorWallet = new Wallet(wallet);
  const provider = new AnchorProvider(connection, anchorWallet, { commitment: "confirmed" });
  anchor.setProvider(provider);
  const program: Program<any> = new Program(IDL, provider);

  // Create all pools
  const configs: Record<string, PoolConfig> = {};

  for (const poolDef of REALISTIC_POOLS) {
    try {
      const config = await createPool(wallet, program, poolDef);
      configs[poolDef.symbol] = config;
    } catch (e: any) {
      console.error(`Failed to create ${poolDef.symbol}:`, e.message);
    }
  }

  // Save
  const configPath = path.resolve(__dirname, "../../pool-configs.json");
  fs.writeFileSync(configPath, JSON.stringify(configs, null, 2));
  
  console.log("\n" + "=".repeat(60));
  console.log("✅ REALISTIC POOLS CREATED!");
  console.log("=".repeat(60));
  
  for (const [sym, config] of Object.entries(configs)) {
    console.log(`${sym}: ${config.poolId}`);
  }
}

main().catch(console.error);
