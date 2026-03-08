#!/usr/bin/env ts-node
/**
 * Interactive Agent Initialization (Encrypted)
 * 
 * Guides you through creating agents with encrypted key storage.
 * Usage: npm run init-interactive
 * 
 * Requires: WALLET_ENCRYPTION_KEY in .env
 */

import { Keypair } from '@solana/web3.js';
import fs from 'fs';
import readline from 'readline';
import dotenv from 'dotenv';
import { TREASURY } from '../src/config';
import { AGENT_DEFINITIONS as DEFAULT_DEFINITIONS, AgentDefinition, calculateAllocations } from '../src/config/agent-definitions';
import { encryptKeypair, decryptKeypair, isValidEncryptionKey } from '../src/utils/encryption';

dotenv.config();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const WALLET_REGISTRY_PATH = './wallet-registry.json';
const AGENT_CONFIG_PATH = './agents.config.json';

interface AgentConfigEntry {
  id: string;
  type: string;
  keypairFile: string;
  label: string;
  emoji: string;
  color: string;
}

const AGENT_TYPE_CONFIGS: Record<string, { label: string; emoji: string; color: string }> = {
  'ARBITRAGEUR': { label: 'Arbitrageur', emoji: '📈', color: 'green' },
  'LIQUIDITY_PROVIDER': { label: 'LiquidityProvider', emoji: '💧', color: 'purple' },
  'BANKER': { label: 'Banker', emoji: '🏦', color: 'orange' },
  'TREND_FOLLOWER': { label: 'TrendFollower', emoji: '📊', color: 'blue' },
};

/**
 * Load existing agent config or return empty array
 */
function loadAgentConfig(): { agents: AgentConfigEntry[] } {
  if (fs.existsSync(AGENT_CONFIG_PATH)) {
    return JSON.parse(fs.readFileSync(AGENT_CONFIG_PATH, 'utf-8'));
  }
  return { agents: [] };
}

/**
 * Save agent config to file
 */
function saveAgentConfig(config: { agents: AgentConfigEntry[] }): void {
  fs.writeFileSync(AGENT_CONFIG_PATH, JSON.stringify(config, null, 2));
}

const AGENT_TYPES = [
  { id: 'ARBITRAGEUR', name: 'Arbitrageur', desc: 'Finds price discrepancies across DEXs', risk: 'LOW' },
  { id: 'LIQUIDITY_PROVIDER', name: 'Liquidity Provider', desc: 'Provides liquidity to earn fees', risk: 'MEDIUM' },
  { id: 'BANKER', name: 'Banker', desc: 'Central liquidity provider for agent swarm', risk: 'LOW' },
  { id: 'TREND_FOLLOWER', name: 'Trend Follower', desc: 'Captures directional price movements', risk: 'HIGH' },
];

function ask(question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve));
}

console.log('='.repeat(70));
console.log('  AGENT MESH - Interactive Agent Initialization');
console.log('='.repeat(70));
console.log();

async function main() {
  // Check encryption key
  const encryptionKey = process.env.WALLET_ENCRYPTION_KEY;
  if (!encryptionKey) {
    console.error('✗ WALLET_ENCRYPTION_KEY not found in environment.');
    console.log('Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    console.log('Then add it to your .env file');
    rl.close();
    process.exit(1);
  }

  if (!isValidEncryptionKey(encryptionKey)) {
    console.error('✗ Invalid WALLET_ENCRYPTION_KEY. Must be 64 hex characters.');
    rl.close();
    process.exit(1);
  }

  // Check treasury exists
  if (!fs.existsSync(TREASURY.KEYPAIR_PATH)) {
    console.error(`✗ Treasury keypair not found: ${TREASURY.KEYPAIR_PATH}`);
    console.log('Run: npm run generate-treasury first');
    rl.close();
    process.exit(1);
  }

  // Load and decrypt treasury keypair
  const treasuryEncrypted = JSON.parse(fs.readFileSync(TREASURY.KEYPAIR_PATH, 'utf-8'));
  const treasurySecret = decryptKeypair(treasuryEncrypted, encryptionKey);
  const treasuryKeypair = Keypair.fromSecretKey(treasurySecret);

  console.log('Treasury:', treasuryKeypair.publicKey.toString());
  console.log('Encryption: ✓ AES-256-GCM');
  console.log();

  // Ask how many agents
  const numAgentsInput = await ask('How many agents do you want to create? (1-10): ');
  const numAgents = parseInt(numAgentsInput);

  if (isNaN(numAgents) || numAgents < 1 || numAgents > 10) {
    console.error('✗ Invalid number. Must be between 1 and 10.');
    rl.close();
    process.exit(1);
  }

  console.log();
  console.log('Available agent roles:');
  AGENT_TYPES.forEach((t, i) => {
    console.log(`  ${i + 1}. ${t.name}`);
    console.log(`     ${t.desc} (Risk: ${t.risk})`);
  });
  console.log();

  // Load existing config to check for duplicates
  const existingConfig = loadAgentConfig();
  const existingIds = new Set(existingConfig.agents.map(a => a.id));
  
  // Collect agent configurations
  const newAgents: Partial<AgentDefinition>[] = [];

  for (let i = 0; i < numAgents; i++) {
    console.log(`\n--- Agent ${i + 1} of ${numAgents} ---`);
    
    const roleInput = await ask('Select role (1-4): ');
    const roleIdx = parseInt(roleInput) - 1;

    if (roleIdx < 0 || roleIdx >= AGENT_TYPES.length) {
      console.error('✗ Invalid role selection');
      i--;
      continue;
    }

    const role = AGENT_TYPES[roleIdx];
    
    const name = await ask(`Enter name (default: ${role.name} ${String.fromCharCode(65 + i)}): `);
    const agentName = name.trim() || `${role.name} ${String.fromCharCode(65 + i)}`;

    const customId = await ask(`Enter ID (default: ${role.id.toLowerCase().replace('_', '-')}-${String(i + 1).padStart(2, '0')}): `);
    let agentId = customId.trim() || `${role.id.toLowerCase().replace('_', '-')}-${String(i + 1).padStart(2, '0')}`;
    
    // Check for duplicate ID
    if (existingIds.has(agentId)) {
      console.log(`⚠️  Agent ID '${agentId}' already exists in config. Skipping...`);
      i--;
      continue;
    }
    
    // Check for duplicate in current batch
    if (newAgents.some(a => a.id === agentId)) {
      console.log(`⚠️  Agent ID '${agentId}' already used in this session. Please choose a different ID.`);
      i--;
      continue;
    }

    newAgents.push({
      id: agentId,
      type: role.id as any,
      name: agentName,
      description: role.desc,
      riskLevel: role.risk as any,
      maxSlippage: role.id === 'ARBITRAGEUR' || role.id === 'MARKET_MAKER' ? 0.005 : 0.01,
      dailyTradeLimit: role.id === 'ARBITRAGEUR' ? 50 : role.id === 'MARKET_MAKER' ? 100 : 20,
      active: true,
    });

    console.log(`✓ Configured: ${agentName} (${agentId})`);
  }

  console.log();
  console.log('Summary:');
  console.log('-'.repeat(70));
  newAgents.forEach((agent, i) => {
    console.log(`${i + 1}. ${agent.name} (${agent.id}) - ${agent.type}`);
  });
  console.log();

  const confirm = await ask('Create these agents? (yes/no): ');
  if (confirm.toLowerCase() !== 'yes') {
    console.log('Cancelled.');
    rl.close();
    process.exit(0);
  }

  // Generate wallets
  console.log();
  console.log('Creating encrypted wallets...');
  console.log();

  const walletRegistry = {
    createdAt: new Date().toISOString(),
    treasury: treasuryKeypair.publicKey.toString(),
    agents: [] as Array<{
      id: string;
      type: string;
      name: string;
      description: string;
      publicKey: string;
      derivationIndex: number;
      keypairPath: string;
    }>,
  };

  for (let i = 0; i < newAgents.length; i++) {
    const agent = newAgents[i];
    
    // Generate deterministic keypair using index
    // Deterministic key derivation
    const crypto = require('crypto');
    const seedInput = Buffer.concat([
      treasuryKeypair.publicKey.toBuffer(),
      Buffer.from([i]),
    ]);
    const seed = crypto.createHash('sha256').update(seedInput).digest();
    const agentKeypair = Keypair.fromSeed(seed);

    const agentKeypairPath = `./agent-keypairs/${agent.id}-keypair.enc.json`;
    if (!fs.existsSync('./agent-keypairs')) {
      fs.mkdirSync('./agent-keypairs', { recursive: true });
    }

    // Encrypt and save keypair
    const encryptedData = encryptKeypair(agentKeypair.secretKey, encryptionKey);
    fs.writeFileSync(agentKeypairPath, JSON.stringify(encryptedData, null, 2));

    walletRegistry.agents.push({
      id: agent.id!,
      type: agent.type!,
      name: agent.name!,
      description: agent.description!,
      publicKey: agentKeypair.publicKey.toString(),
      derivationIndex: i,
      keypairPath: agentKeypairPath,
    });

    console.log(`✓ ${agent.name}`);
    console.log(`  ID: ${agent.id}`);
    console.log(`  Type: ${agent.type}`);
    console.log(`  Address: ${agentKeypair.publicKey.toString()}`);
    console.log(`  Encrypted: ${agentKeypairPath}`);
    console.log();
  }

  // Save wallet registry
  fs.writeFileSync(WALLET_REGISTRY_PATH, JSON.stringify(walletRegistry, null, 2));

  // Append new agents to agents.config.json
  for (const agent of newAgents) {
    const typeConfig = AGENT_TYPE_CONFIGS[agent.type!] || { label: agent.type!, emoji: '🤖', color: 'green' };
    const configEntry: AgentConfigEntry = {
      id: agent.id!,
      type: agent.type!,
      keypairFile: agent.id!,
      label: typeConfig.label,
      emoji: typeConfig.emoji,
      color: typeConfig.color,
    };
    existingConfig.agents.push(configEntry);
    console.log(`✅ Added ${agent.id} to agents.config.json`);
  }
  saveAgentConfig(existingConfig);

  // Save agent definitions for funding step
  const definitionsForFunding = {
    createdAt: new Date().toISOString(),
    agents: newAgents.map((agent, i) => ({
      ...agent,
      derivationIndex: i,
      publicKey: walletRegistry.agents[i].publicKey,
    })),
  };
  fs.writeFileSync('./agent-definitions-temp.json', JSON.stringify(definitionsForFunding, null, 2));

  console.log();
  console.log('='.repeat(70));
  console.log('✓ Agents initialized successfully!');
  console.log('='.repeat(70));
  console.log();
  console.log('Wallet Registry:', WALLET_REGISTRY_PATH);
  console.log('Agent Config:', AGENT_CONFIG_PATH);
  console.log();
  console.log('NEXT STEP:');
  console.log('  npm run fund-interactive');
  console.log();
  console.log('This will guide you through funding each agent from treasury.');
  console.log();

  rl.close();
}

main().catch(error => {
  console.error('Error:', error);
  rl.close();
  process.exit(1);
});
