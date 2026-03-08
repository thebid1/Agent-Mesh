/**
 * Create single AMM Pool using Anchor AMM
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
import * as dotenv from 'dotenv';
dotenv.config();
const IDL: any = require("./idl.json");
const PROGRAM_ID = new PublicKey("5LU3snhGuiRYF1u1W3cX8xUYoPbNYiZHKPQgqZgxQJi6");
const NETWORK = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';

interface TokenConfig {
  mint: string;
  decimals: number;
  initialTokens: number;
  initialSol: number;
}

const TOKEN_CONFIGS: Record<string, TokenConfig> = {
  // New tokens from Metaplex - All 6 decimals, 1M supply
  // Optimized for volatility: small reserves = big price moves
  
  AUSDC: { mint: "B7tFhVdFeafrdBcCEWsjDXr3rUqkwXMmtbDKkJDy6PqE", decimals: 6, initialTokens: 500, initialSol: 5 },     // 1 SOL = 100 USDC
  ABTC: { mint: "eL6FAw3nzY8ftwjwtgJnGWAdb4aNZHmsK5H39f2F4tN", decimals: 6, initialTokens: 5, initialSol: 5 },       // 1 SOL = 1 BTC
  AETH: { mint: "8L4wBtjbS4bjJXDhg8QHpVkvNfqamvCddAzqtMetr1DC", decimals: 6, initialTokens: 50, initialSol: 5 },      // 1 SOL = 10 ETH
  ASOL: { mint: "4XXFcpZM7w2RD2r8nQz2UST67f8kef4JohPzp1Y72Y69", decimals: 6, initialTokens: 500, initialSol: 5 },     // 1 SOL = 100 ASOL
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
  createdAt: string;
}

async function createPool(tokenSymbol: string): Promise<void> {
  const config = TOKEN_CONFIGS[tokenSymbol];
  if (!config) {
    throw new Error(`Unknown token: ${tokenSymbol}`);
  }

  // Load treasury wallet
  const keypairPath = path.resolve(__dirname, "../../treasury-keypair.json");
  const secretKey: number[] = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  const wallet = Keypair.fromSecretKey(new Uint8Array(secretKey));

  const connection = new Connection(NETWORK, "confirmed");
  
  console.log(`Treasury: ${wallet.publicKey.toBase58()}`);
  const balance = await connection.getBalance(wallet.publicKey);
  console.log(`Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL\n`);

  console.log(`\n🏊 Creating ${tokenSymbol}/SOL pool...`);
  console.log(`   Token: ${config.mint}`);
  console.log(`   Initial: ${config.initialTokens} ${tokenSymbol} + ${config.initialSol} SOL\n`);

  const mintA = new PublicKey(config.mint);
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

  console.log(`Pool PDA: ${poolPda.toBase58()}`);
  console.log(`Vault A (${tokenSymbol}): ${vaultA.toBase58()}`);
  console.log(`Vault B (SOL): ${vaultB.toBase58()}`);

  // Check if pool exists
  const poolAccount = await connection.getAccountInfo(poolPda);
  if (poolAccount) {
    console.log("⚠️  Pool already exists!");
    return;
  }

  // Setup provider and program
  const anchorWallet = new Wallet(wallet);
  const provider = new AnchorProvider(connection, anchorWallet, { commitment: "confirmed" });
  anchor.setProvider(provider);
  const program: Program<any> = new Program(IDL, provider);

  // Initialize pool
  console.log("\n📦 Initializing pool...");
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

  console.log(`✅ Pool initialized!`);
  console.log(`   Transaction: ${initTx}`);

  // Setup token accounts
  console.log("\n💧 Adding liquidity...");
  const userTokenA = await getOrCreateAssociatedTokenAccount(connection, wallet, mintA, wallet.publicKey);
  const userTokenB = await getOrCreateAssociatedTokenAccount(connection, wallet, mintB, wallet.publicKey);

  // Wrap SOL
  const wrapTx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, userTokenB.address, wallet.publicKey, NATIVE_MINT),
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: userTokenB.address,
      lamports: Math.floor(config.initialSol * LAMPORTS_PER_SOL),
    }),
    createSyncNativeInstruction(userTokenB.address)
  );
  await sendAndConfirmTransaction(connection, wrapTx, [wallet]);
  console.log(`   Wrapped ${config.initialSol} SOL`);

  // Add liquidity
  const amountA = new BN(config.initialTokens * 10 ** config.decimals);
  const amountB = new BN(Math.floor(config.initialSol * LAMPORTS_PER_SOL));

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

  console.log(`✅ Liquidity added!`);
  console.log(`   Transaction: ${liqTx}`);

  // Save pool config
  const poolConfig: PoolConfig = {
    tokenSymbol,
    poolId: poolPda.toBase58(),
    vaultA: vaultA.toBase58(),
    vaultB: vaultB.toBase58(),
    mintA: mintA.toBase58(),
    mintB: mintB.toBase58(),
    decimalsA: config.decimals,
    decimalsB: 9,
    createdAt: new Date().toISOString(),
  };

  const configPath = path.resolve(__dirname, "../../pool-configs.json");
  let configs: Record<string, PoolConfig> = {};
  if (fs.existsSync(configPath)) {
    configs = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  }
  configs[tokenSymbol] = poolConfig;
  fs.writeFileSync(configPath, JSON.stringify(configs, null, 2));

  console.log(`\n🎉 ${tokenSymbol}/SOL pool created successfully!`);
  console.log(`   Pool: ${poolPda.toBase58()}`);
  console.log(`   Config saved to pool-configs.json`);
}

async function main(): Promise<void> {
  const tokenSymbol: string | undefined = process.argv[2]?.toUpperCase();
  
  if (!tokenSymbol || !TOKEN_CONFIGS[tokenSymbol]) {
    console.error("Usage: npx ts-node createPool.ts <TOKEN_SYMBOL>");
    console.error("Valid tokens:", Object.keys(TOKEN_CONFIGS).join(", "));
    process.exit(1);
  }

  await createPool(tokenSymbol);
}

main().catch(console.error);
