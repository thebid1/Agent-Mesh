import { Keypair, PublicKey, Connection, LAMPORTS_PER_SOL, Transaction, SystemProgram, sendAndConfirmTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount, createAssociatedTokenAccountInstruction } from '@solana/spl-token';
import { AgentWallet, TransactionResult, AgentType } from '../types';
import { NETWORK } from '../config';
import { decryptKeypair, isValidEncryptionKey } from '../utils/encryption';
import fs from 'fs';
import path from 'path';

interface AgentConfigEntry {
  id: string;
  type: AgentType;
  keypairFile: string;
  label?: string;
  emoji?: string;
  color?: string;
}

export class WalletManager {
  private connection: Connection;
  private wallets: Map<string, AgentWallet> = new Map();
  private encryptionKey: string;

  constructor(connection?: Connection) {
    this.connection = connection || new Connection(NETWORK.RPC_URL, NETWORK.COMMITMENT);
    
    // Load encryption key from environment
    this.encryptionKey = process.env.WALLET_ENCRYPTION_KEY || '';
    if (!this.encryptionKey) {
      throw new Error('WALLET_ENCRYPTION_KEY not found in environment');
    }
    if (!isValidEncryptionKey(this.encryptionKey)) {
      throw new Error('Invalid WALLET_ENCRYPTION_KEY. Must be 64 hex characters.');
    }
  }

  async loadAgentWallets(): Promise<void> {
    // Read agent configurations from agents.config.json
    const configPath = path.resolve(process.cwd(), 'agents.config.json');
    
    if (!fs.existsSync(configPath)) {
      throw new Error('No agents configured. Run `npm run init` to create agents.');
    }

    const configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const agentConfigs: AgentConfigEntry[] = configData.agents || [];

    if (agentConfigs.length === 0) {
      throw new Error('No agents configured. Run `npm run init` to create agents.');
    }

    for (const config of agentConfigs) {
      const keypairPath = `./agent-keypairs/${config.keypairFile}-keypair.enc.json`;
      
      if (!fs.existsSync(keypairPath)) {
        throw new Error(`Encrypted keypair not found: ${keypairPath}`);
      }

      // Load and decrypt the keypair
      const encryptedData = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
      const secretKey = decryptKeypair(encryptedData, this.encryptionKey);
      const keypair = Keypair.fromSecretKey(secretKey);

      this.wallets.set(config.id, {
        keypair,
        publicKey: keypair.publicKey,
        derivationPath: keypairPath,
        agentId: config.id,
        agentType: config.type,
      });
    }
  }

  /**
   * Create a new encrypted agent wallet
   * Generates a fresh keypair, encrypts it, and saves to disk
   */
  async createAgentWallet(agentId: string, agentType: AgentType): Promise<PublicKey> {
    // Prevent overwrites
    const keypairPath = `./agent-keypairs/${agentId}-keypair.enc.json`;
    if (fs.existsSync(keypairPath)) {
      throw new Error(`Wallet already exists for agent: ${agentId}`);
    }
    
    // Generate new keypair
    const keypair = Keypair.generate();
    

    const { encryptKeypair } = await import('../utils/encryption');
    const encrypted = encryptKeypair(keypair.secretKey, this.encryptionKey);
    
    // Save encrypted keypair
    if (!fs.existsSync('./agent-keypairs')) {
      fs.mkdirSync('./agent-keypairs', { recursive: true });
    }
    fs.writeFileSync(keypairPath, JSON.stringify(encrypted, null, 2));
    
    // Store in memory
    this.wallets.set(agentId, {
      keypair,
      publicKey: keypair.publicKey,
      derivationPath: keypairPath,
      agentId,
      agentType,
    });
    
    console.log(`✅ Created encrypted wallet for ${agentId}: ${keypair.publicKey.toString()}`);
    return keypair.publicKey;
  }

  /**
   * Load a wallet from an encrypted keypair file
   */
  async loadEncryptedWallet(agentId: string, agentType: AgentType, keypairPath: string): Promise<AgentWallet> {
    if (!fs.existsSync(keypairPath)) {
      throw new Error(`Encrypted keypair not found: ${keypairPath}`);
    }

    const encryptedData = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
    const secretKey = decryptKeypair(encryptedData, this.encryptionKey);
    const keypair = Keypair.fromSecretKey(secretKey);

    const wallet: AgentWallet = {
      keypair,
      publicKey: keypair.publicKey,
      derivationPath: keypairPath,
      agentId,
      agentType,
    };

    this.wallets.set(agentId, wallet);
    return wallet;
  }

  getWallet(agentId: string): AgentWallet | undefined {
    return this.wallets.get(agentId);
  }

  getAllWallets(): AgentWallet[] {
    return Array.from(this.wallets.values());
  }

  async getBalance(agentId: string): Promise<number> {
    const wallet = this.wallets.get(agentId);
    if (!wallet) throw new Error(`Wallet not found: ${agentId}`);
    const balance = await this.connection.getBalance(wallet.publicKey);
    return balance / LAMPORTS_PER_SOL;
  }

  async getTokenBalance(agentId: string, mintAddress: string): Promise<number> {
    const wallet = this.wallets.get(agentId);
    if (!wallet) throw new Error(`Wallet not found: ${agentId}`);
    try {
      const mint = new PublicKey(mintAddress);
      const ata = await getAssociatedTokenAddress(mint, wallet.publicKey);
      const account = await getAccount(this.connection, ata);
      return Number(account.amount);
    } catch {
      return 0;
    }
  }

  async transfer(fromAgentId: string, toAddress: string, amountSol: number): Promise<TransactionResult> {
    const wallet = this.wallets.get(fromAgentId);
    if (!wallet) throw new Error(`Wallet not found: ${fromAgentId}`);

    try {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: new PublicKey(toAddress),
          lamports: amountSol * LAMPORTS_PER_SOL,
        })
      );
      const signature = await sendAndConfirmTransaction(this.connection, tx, [wallet.keypair]);
      return { success: true, signature };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async createTokenAccount(agentId: string, mintAddress: string): Promise<TransactionResult> {
    const wallet = this.wallets.get(agentId);
    if (!wallet) throw new Error(`Wallet not found: ${agentId}`);

    try {
      const mint = new PublicKey(mintAddress);
      const ata = await getAssociatedTokenAddress(mint, wallet.publicKey);
      
      try {
        await getAccount(this.connection, ata);
        return { success: true };
      } catch {
        const tx = new Transaction().add(
          createAssociatedTokenAccountInstruction(wallet.publicKey, ata, wallet.publicKey, mint)
        );
        const signature = await sendAndConfirmTransaction(this.connection, tx, [wallet.keypair]);
        return { success: true, signature };
      }
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async getWalletInfo(agentId: string): Promise<any> {
    const wallet = this.wallets.get(agentId);
    if (!wallet) throw new Error(`Wallet not found: ${agentId}`);

    return {
      agentId: wallet.agentId,
      agentType: wallet.agentType,
      publicKey: wallet.publicKey.toString(),
      balances: {
        SOL: await this.getBalance(agentId),
      },
    };
  }
}
