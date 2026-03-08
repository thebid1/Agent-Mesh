#!/usr/bin/env ts-node
import { Connection } from '@solana/web3.js';
import * as dotenv from 'dotenv';
import { WalletManager } from './wallet/WalletManager';
import { ArbitrageurAgent } from './agents/ArbitrageurAgent';
import { TrendFollowerAgent } from './agents/TrendFollowerAgent';
import { LiquidityProviderAgent } from './agents/LiquidityProviderAgent';
import { BankerAgent } from './agents/BankerAgent';
import { NETWORK } from './config';
import fs from 'fs';
import path from 'path';

dotenv.config();

const AGENT_TYPE = process.env.AGENT_TYPE || 'ARBITRAGEUR'; // ARBITRAGEUR, TREND, LP, or BANKER

/**
 * Find agent config from agents.config.json by type
 */
function findAgentConfig(type: string) {
  const configPath = path.resolve(process.cwd(), 'agents.config.json');
  if (!fs.existsSync(configPath)) {
    return null;
  }
  
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  
  // Map env type to config type
  const typeMap: Record<string, string> = {
    'TREND': 'TREND_FOLLOWER',
    'LP': 'LIQUIDITY_PROVIDER',
    'BANKER': 'BANKER',
    'ARBITRAGEUR': 'ARBITRAGEUR',
  };
  
  const targetType = typeMap[type] || type;
  return config.agents?.find((a: any) => a.type === targetType) || null;
}

console.log('='.repeat(70));
console.log('  AGENT MESH - Live Trading on Devnet');
console.log('='.repeat(70));
console.log(`  Agent Type: ${AGENT_TYPE}`);
console.log();

const activeAgents: (ArbitrageurAgent | TrendFollowerAgent | LiquidityProviderAgent | BankerAgent)[] = [];
let isShuttingDown = false;

async function main() {
  console.log('Connecting to Solana...');
  const connection = new Connection(NETWORK.RPC_URL, NETWORK.COMMITMENT);
  
  try {
    const version = await connection.getVersion();
    console.log('✓ Connected to Solana devnet');
    console.log();
  } catch (error) {
    console.error('✗ Connection failed');
    process.exit(1);
  }

  console.log('Loading wallets...');
  const walletManager = new WalletManager(connection);
  await walletManager.loadAgentWallets();

  for (const wallet of walletManager.getAllWallets()) {
    const balance = await walletManager.getBalance(wallet.agentId);
    console.log(`  ${wallet.agentId}: ${balance.toFixed(4)} SOL`);
  }
  console.log();

  // Find agent config from agents.config.json
  const agentEntry = findAgentConfig(AGENT_TYPE);
  
  if (!agentEntry) {
    console.error(`✗ No agent found in agents.config.json for type: ${AGENT_TYPE}`);
    console.log('Run `npm run init` to create agents first.');
    process.exit(1);
  }

  if (AGENT_TYPE === 'TREND') {
    console.log('Starting Trend Follower Agent...');
    console.log(`Agent ID: ${agentEntry.id}`);
    console.log('Strategy: MA Crossover (Golden Cross BUY / Death Cross SELL)');
    console.log('Press Ctrl+C to stop');
    console.log('='.repeat(70));
    console.log();

    const config = {
      id: agentEntry.id,
      type: 'TREND_FOLLOWER' as const,
      name: agentEntry.label || 'Trend Follower',
      description: 'Follows price trends using moving averages',
      initialBalance: 1,
      maxSlippage: 0.005,
      dailyTradeLimit: 50,
      riskLevel: 'MEDIUM' as const,
    };

    const trendFollower = new TrendFollowerAgent(config, connection, walletManager);
    await trendFollower.initialize();
    
    activeAgents.push(trendFollower);
    
    trendFollower.run().catch((err: any) => {
      console.error('Agent error:', err.message);
    });

  } else if (AGENT_TYPE === 'LP') {
    console.log('Starting Liquidity Provider Agent...');
    console.log(`Agent ID: ${agentEntry.id}`);
    console.log('Strategy: Add liquidity to pools based on TVL and ratios');
    console.log('Press Ctrl+C to stop');
    console.log('='.repeat(70));
    console.log();

    const config = {
      id: agentEntry.id,
      type: 'LIQUIDITY_PROVIDER' as const,
      name: agentEntry.label || 'Liquidity Provider',
      description: 'Provides liquidity to AMM pools',
      initialBalance: 1,
      maxSlippage: 0.01,
      dailyTradeLimit: 20,
      riskLevel: 'LOW' as const,
    };

    const lpAgent = new LiquidityProviderAgent(config, connection, walletManager);
    await lpAgent.initialize();
    
    activeAgents.push(lpAgent);
    
    lpAgent.run().catch((err: any) => {
      console.error('Agent error:', err.message);
    });

  } else if (AGENT_TYPE === 'BANKER') {
    console.log('Starting Banker Agent...');
    console.log(`Agent ID: ${agentEntry.id}`);
    console.log('Role: Central Liquidity Provider for Agent Swarm');
    console.log('Press Ctrl+C to stop');
    console.log('='.repeat(70));
    console.log();

    const config = {
      id: agentEntry.id,
      type: 'BANKER' as const,
      name: agentEntry.label || 'Banker',
      description: 'Provides liquidity to other agents',
      initialBalance: 10,
      maxSlippage: 0.005,
      dailyTradeLimit: 100,
      riskLevel: 'LOW' as const,
    };

    const banker = new BankerAgent(config, connection, walletManager);
    await banker.initialize();
    
    activeAgents.push(banker);
    
    banker.run().catch((err: any) => {
      console.error('Agent error:', err.message);
    });

  } else {
    console.log('Starting Arbitrageur Agent...');
    console.log(`Agent ID: ${agentEntry.id}`);
    console.log('Strategy: Price Momentum (Buy the Dip / Sell the Rally)');
    console.log('Press Ctrl+C to stop');
    console.log('='.repeat(70));
    console.log();

    const config = {
      id: agentEntry.id,
      type: 'ARBITRAGEUR' as const,
      name: agentEntry.label || 'Arbitrageur',
      description: 'Finds price discrepancies',
      initialBalance: 5,
      maxSlippage: 0.005,
      dailyTradeLimit: 50,
      riskLevel: 'LOW' as const,
    };

    const arbitrageur = new ArbitrageurAgent(config, connection, walletManager);
    await arbitrageur.initialize();
    
    activeAgents.push(arbitrageur);
    
    arbitrageur.run().catch((err: any) => {
      console.error('Agent error:', err.message);
    });
  }

  while (!isShuttingDown) {
    await new Promise(r => setTimeout(r, 1000));
  }
}

process.on('SIGINT', async () => {
  console.log('\n\nShutting down...');
  isShuttingDown = true;
  activeAgents.forEach(a => a.stop());
  await new Promise(r => setTimeout(r, 2000));
  console.log('Goodbye!');
  process.exit(0);
});

main().catch(error => {
  console.error('Fatal:', error.message);
  process.exit(1);
});
