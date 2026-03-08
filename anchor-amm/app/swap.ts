/**
 * Execute swaps using Anchor AMM
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
  createCloseAccountInstruction,
  getOrCreateAssociatedTokenAccount,
  getAccount,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import dotenv from 'dotenv';
dotenv.config();
const IDL: any = require("./idl.json");
const PROGRAM_ID = new PublicKey("5LU3snhGuiRYF1u1W3cX8xUYoPbNYiZHKPQgqZgxQJi6");
const NETWORK = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';

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

function calculateSwapOutput(amountIn: number, reserveIn: number, reserveOut: number): number {
  return (amountIn * reserveOut) / (reserveIn + amountIn);
}

async function executeSwap(
  walletPath: string,
  tokenSymbol: string,
  direction: "A_TO_B" | "B_TO_A",
  amountIn: number,
  slippagePct: number = 2
): Promise<void> {
  // Load pool config
  const configPath = path.resolve(__dirname, "../../pool-configs.json");
  if (!fs.existsSync(configPath)) {
    throw new Error("No pool configs found. Create pools first.");
  }
  const configs: Record<string, PoolConfig> = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  const poolConfig: PoolConfig | undefined = configs[tokenSymbol];
  if (!poolConfig) {
    throw new Error(`Pool for ${tokenSymbol} not found`);
  }

  // Load wallet
  const secretKey: number[] = JSON.parse(fs.readFileSync(walletPath, "utf-8"));
  const wallet = Keypair.fromSecretKey(new Uint8Array(secretKey));

  const connection = new Connection(NETWORK, "confirmed");
  console.log(`Wallet: ${wallet.publicKey.toBase58()}`);

  // Setup provider
  const anchorWallet = new Wallet(wallet);
  const provider = new AnchorProvider(connection, anchorWallet, { commitment: "confirmed" });
  anchor.setProvider(provider);
  const program: Program<any> = new Program(IDL, provider);

  const poolPda = new PublicKey(poolConfig.poolId);
  const vaultA = new PublicKey(poolConfig.vaultA);
  const vaultB = new PublicKey(poolConfig.vaultB);
  const mintA = new PublicKey(poolConfig.mintA);
  const mintB = NATIVE_MINT;

  // Get reserves
  const accountA = await getAccount(connection, vaultA);
  const accountB = await getAccount(connection, vaultB);
  const reserveA = Number(accountA.amount) / 10 ** poolConfig.decimalsA;
  const reserveB = Number(accountB.amount) / 10 ** poolConfig.decimalsB;

  const aToB = direction === "A_TO_B";
  const [reserveIn, reserveOut, decimalsIn, decimalsOut]: [number, number, number, number] = aToB
    ? [reserveA, reserveB, poolConfig.decimalsA, poolConfig.decimalsB]
    : [reserveB, reserveA, poolConfig.decimalsB, poolConfig.decimalsA];

  const amountOut = calculateSwapOutput(amountIn, reserveIn, reserveOut);
  const minAmountOut = amountOut * (1 - slippagePct / 100);

  console.log(`\n🔄 Swap: ${amountIn.toFixed(6)} ${aToB ? tokenSymbol : "SOL"}`);
  console.log(`   Expected: ${amountOut.toFixed(6)} ${aToB ? "SOL" : tokenSymbol}`);
  console.log(`   Min: ${minAmountOut.toFixed(6)} (${slippagePct}% slippage)`);

  // Get user token accounts
  const userTokenA = await getOrCreateAssociatedTokenAccount(connection, wallet, mintA, wallet.publicKey);
  const userTokenB = await getOrCreateAssociatedTokenAccount(connection, wallet, mintB, wallet.publicKey);

  // Wrap SOL if needed (B->A = SOL -> Token)
  if (!aToB) {
    console.log("   Wrapping SOL...");
    const wrapTx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, userTokenB.address, wallet.publicKey, NATIVE_MINT),
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: userTokenB.address,
        lamports: Math.floor(amountIn * LAMPORTS_PER_SOL),
      }),
      createSyncNativeInstruction(userTokenB.address)
    );
    await sendAndConfirmTransaction(connection, wrapTx, [wallet]);
    console.log("   ✅ SOL wrapped");
  }

  // Execute swap
  const amountInRaw = new BN(Math.floor(amountIn * 10 ** decimalsIn));
  const minAmountOutRaw = new BN(Math.floor(minAmountOut * 10 ** decimalsOut));

  try {
    console.log("   Executing swap...");
    const tx: string = await (program.methods as any)
      .swap(amountInRaw, minAmountOutRaw, aToB)
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

    // Unwrap wSOL if swapped to SOL
    if (aToB) {
      console.log("   Unwrapping wSOL...");
      const unwrapTx = new Transaction().add(
        createCloseAccountInstruction(userTokenB.address, wallet.publicKey, wallet.publicKey)
      );
      await sendAndConfirmTransaction(connection, unwrapTx, [wallet]);
      console.log("   ✅ SOL unwrapped");
    }

    console.log(`\n✅ Swap successful!`);
    console.log(`   Signature: ${tx}`);
    console.log(`   Explorer: https://explorer.solana.com/tx/${tx}?cluster=devnet`);

  } catch (error: any) {
    console.error(`\n❌ Swap failed:`, error.message);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const tokenSymbol: string | undefined = process.argv[2]?.toUpperCase();
  const direction: "A_TO_B" | "B_TO_A" | undefined = process.argv[3] as any;
  const amount: number = parseFloat(process.argv[4] || "");

  if (!tokenSymbol || !direction || isNaN(amount)) {
    console.error("Usage: npx ts-node swap.ts <TOKEN> <DIRECTION> <AMOUNT>");
    console.error("Directions: A_TO_B (Token->SOL) or B_TO_A (SOL->Token)");
    console.error("Example: npx ts-node swap.ts AGENTUSDC B_TO_A 0.1");
    process.exit(1);
  }

  const walletPath = path.resolve(__dirname, "../../agent-keypairs/arbitrageur-01-keypair.json");
  await executeSwap(walletPath, tokenSymbol, direction, amount);
}

main().catch(console.error);
