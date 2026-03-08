/**
 * Beautified Logger for Agent Mesh
 * Color-coded logs by agent type with emoji indicators
 */

import fs from 'fs';
import path from 'path';

// Type-based defaults for colors and emojis
const TYPE_COLORS: Record<string, string> = {
  'ARBITRAGEUR': '\x1b[36m',      // cyan
  'LIQUIDITY_PROVIDER': '\x1b[32m', // green
  'BANKER': '\x1b[35m',           // magenta
  'TREND_FOLLOWER': '\x1b[33m',   // yellow
};

const TYPE_EMOJIS: Record<string, string> = {
  'ARBITRAGEUR': '🎯',
  'LIQUIDITY_PROVIDER': '💧',
  'BANKER': '🏦',
  'TREND_FOLLOWER': '📈',
};

let agentTypeCache: Map<string, string> | null = null;

function getAgentType(agentId: string): string | null {
  // Use cache if available
  if (agentTypeCache) {
    return agentTypeCache.get(agentId) || null;
  }
  
  // Build cache from config
  agentTypeCache = new Map();
  try {
    const configPath = path.resolve(process.cwd(), 'agents.config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      for (const agent of config.agents || []) {
        agentTypeCache.set(agent.id, agent.type);
      }
    }
  } catch {
    // Ignore errors, use defaults
  }
  
  return agentTypeCache.get(agentId) || null;
}

export class Logger {
  private static colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    
    // Foreground colors
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    
    // Background colors
    bgRed: '\x1b[41m',
    bgGreen: '\x1b[42m',
    bgYellow: '\x1b[43m',
    bgBlue: '\x1b[44m',
  };

  private static getAgentColor(agentId: string): string {
    const type = getAgentType(agentId);
    if (type && TYPE_COLORS[type]) {
      return TYPE_COLORS[type];
    }
    if (agentId === 'volatility-generator') return Logger.colors.red;
    return Logger.colors.white;
  }

  private static getAgentEmoji(agentId: string): string {
    const type = getAgentType(agentId);
    if (type && TYPE_EMOJIS[type]) {
      return TYPE_EMOJIS[type];
    }
    if (agentId === 'volatility-generator') return '⚡';
    return '🤖';
  }

  static log(agentId: string, message: string, type: 'info' | 'success' | 'warning' | 'error' | 'trade' = 'info'): void {
    const color = this.getAgentColor(agentId);
    const emoji = this.getAgentEmoji(agentId);
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
    
    let typeEmoji = '';
    let typeColor = '';
    
    switch (type) {
      case 'success':
        typeEmoji = '✅';
        typeColor = this.colors.green;
        break;
      case 'warning':
        typeEmoji = '⚠️';
        typeColor = this.colors.yellow;
        break;
      case 'error':
        typeEmoji = '❌';
        typeColor = this.colors.red;
        break;
      case 'trade':
        typeEmoji = '💰';
        typeColor = this.colors.bright + this.colors.green;
        break;
      default:
        typeEmoji = 'ℹ️';
        typeColor = '';
    }

    const prefix = `${this.colors.dim}[${timestamp}]${this.colors.reset} ${emoji} ${color}[${agentId}]${this.colors.reset}`;
    const suffix = typeColor ? `${typeColor}${typeEmoji}${this.colors.reset} ` : '';
    
    console.log(`${prefix} ${suffix}${message}`);
  }

  static header(title: string): void {
    console.log('\n' + this.colors.bright + this.colors.bgBlue + ' '.repeat(70) + this.colors.reset);
    console.log(this.colors.bright + this.colors.bgBlue + title.padStart(35 + title.length / 2).padEnd(70) + this.colors.reset);
    console.log(this.colors.bright + this.colors.bgBlue + ' '.repeat(70) + this.colors.reset + '\n');
  }

  static section(title: string): void {
    console.log('\n' + this.colors.bright + this.colors.cyan + '═'.repeat(70) + this.colors.reset);
    console.log(this.colors.bright + this.colors.cyan + `  ${title}` + this.colors.reset);
    console.log(this.colors.bright + this.colors.cyan + '═'.repeat(70) + this.colors.reset);
  }

  static table(data: Record<string, string | number>): void {
    const maxKeyLength = Math.max(...Object.keys(data).map(k => k.length));
    
    Object.entries(data).forEach(([key, value]) => {
      const paddedKey = key.padEnd(maxKeyLength);
      console.log(`  ${this.colors.dim}${paddedKey}:${this.colors.reset} ${this.colors.bright}${value}${this.colors.reset}`);
    });
  }

  static progressBar(current: number, total: number, width: number = 30): string {
    const percentage = Math.min(100, Math.max(0, (current / total) * 100));
    const filled = Math.round((percentage / 100) * width);
    const empty = width - filled;
    
    const bar = this.colors.green + '█'.repeat(filled) + this.colors.dim + '░'.repeat(empty) + this.colors.reset;
    return `[${bar}] ${percentage.toFixed(1)}%`;
  }

  static separator(): void {
    console.log(this.colors.dim + '─'.repeat(70) + this.colors.reset);
  }
}

// Export convenience functions
export const log = (agentId: string, message: string, type?: 'info' | 'success' | 'warning' | 'error' | 'trade') => 
  Logger.log(agentId, message, type);

export const header = (title: string) => Logger.header(title);
export const section = (title: string) => Logger.section(title);
export const table = (data: Record<string, string | number>) => Logger.table(data);
export const progressBar = (current: number, total: number) => Logger.progressBar(current, total);
