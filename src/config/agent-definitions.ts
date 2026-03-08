// Agent Definitions - Dynamically loaded from agents.config.json

import fs from 'fs';
import path from 'path';

export interface AgentDefinition {
  id: string;
  type: 'ARBITRAGEUR' | 'LIQUIDITY_PROVIDER' | 'BANKER' | 'TREND_FOLLOWER' | 'CUSTOM';
  name: string;
  description: string;
  // Funding allocation (in SOL, or 'auto' for equal split of remainder)
  solAllocation: number | 'auto';
  // Agent behavior config
  maxSlippage: number;
  dailyTradeLimit: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  // Is this agent active?
  active: boolean;
}

interface AgentConfigEntry {
  id: string;
  type: 'ARBITRAGEUR' | 'LIQUIDITY_PROVIDER' | 'BANKER' | 'TREND_FOLLOWER' | 'CUSTOM';
  keypairFile: string;
  label?: string;
  emoji?: string;
  color?: string;
}

/**
 * Load agent definitions from agents.config.json
 * Maps config entries to full AgentDefinition objects
 */
export function loadAgentDefinitions(): AgentDefinition[] {
  const configPath = path.resolve(process.cwd(), 'agents.config.json');
  
  if (!fs.existsSync(configPath)) {
    return [];
  }

  const configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const agents: AgentConfigEntry[] = configData.agents || [];

  return agents.map(agent => {
    // Map agent type to default configuration
    const defaults = getAgentDefaults(agent.type);
    
    return {
      id: agent.id,
      type: agent.type,
      name: agent.label || agent.id,
      description: defaults.description,
      solAllocation: defaults.solAllocation,
      maxSlippage: defaults.maxSlippage,
      dailyTradeLimit: defaults.dailyTradeLimit,
      riskLevel: defaults.riskLevel,
      active: true,
    };
  });
}

/**
 * Get default configuration for an agent type
 */
function getAgentDefaults(type: string): Omit<AgentDefinition, 'id' | 'type' | 'name'> {
  switch (type) {
    case 'ARBITRAGEUR':
      return {
        description: 'Finds and exploits price discrepancies across DEXs',
        solAllocation: 5,
        maxSlippage: 0.005,
        dailyTradeLimit: 50,
        riskLevel: 'LOW',
        active: true,
      };
    case 'LIQUIDITY_PROVIDER':
      return {
        description: 'Provides liquidity to earn trading fees',
        solAllocation: 10,
        maxSlippage: 0.01,
        dailyTradeLimit: 10,
        riskLevel: 'MEDIUM',
        active: true,
      };
    case 'BANKER':
      return {
        description: 'Central liquidity provider for agent swarm - monitors and funds agents',
        solAllocation: 5,
        maxSlippage: 0.005,
        dailyTradeLimit: 50,
        riskLevel: 'LOW',
        active: true,
      };
    case 'TREND_FOLLOWER':
      return {
        description: 'Captures directional price movements using AI analysis',
        solAllocation: 'auto',
        maxSlippage: 0.01,
        dailyTradeLimit: 20,
        riskLevel: 'HIGH',
        active: true,
      };
    default:
      return {
        description: 'Custom agent',
        solAllocation: 'auto',
        maxSlippage: 0.01,
        dailyTradeLimit: 10,
        riskLevel: 'MEDIUM',
        active: true,
      };
  }
}

/**
 * Legacy: Hardcoded agent definitions for backward compatibility
 * @deprecated Use loadAgentDefinitions() instead
 */
export const AGENT_DEFINITIONS: AgentDefinition[] = loadAgentDefinitions();

// Calculate allocations
export function calculateAllocations(treasuryBalanceSol: number, definitions: AgentDefinition[]) {
  const activeAgents = definitions.filter(a => a.active);
  const fixedAllocations = activeAgents.filter(a => typeof a.solAllocation === 'number') as Array<AgentDefinition & { solAllocation: number }>;
  const autoAgents = activeAgents.filter(a => a.solAllocation === 'auto');

  const totalFixed = fixedAllocations.reduce((sum, a) => sum + a.solAllocation, 0);
  const remainder = Math.max(0, treasuryBalanceSol - totalFixed - 0.5);

  const autoAmount = autoAgents.length > 0 ? remainder / autoAgents.length : 0;

  const allocations = activeAgents.map(agent => ({
    ...agent,
    calculatedSol: agent.solAllocation === 'auto' ? autoAmount : agent.solAllocation,
  }));

  return {
    allocations,
    totalFixed,
    autoAmount,
    remainder,
    totalRequired: totalFixed + (autoAmount * autoAgents.length),
  };
}
