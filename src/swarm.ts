#!/usr/bin/env ts-node
/**
 * Agent Mesh - Swarm Launcher
 * 
 * Launches all configured agents simultaneously with color-coded output.
 * Reads agent list from agents.config.json
 * 
 * Usage: npm run swarm
 */

import { spawn, ChildProcess } from 'child_process';
import * as readline from 'readline';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

// Color codes for terminal output
const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  
  // Agent colors
  green: '\x1b[38;5;82m',      // Bright green
  blue: '\x1b[38;5;39m',        // Bright blue
  purple: '\x1b[38;5;141m',     // Purple
  orange: '\x1b[38;5;208m',     // Orange
  cyan: '\x1b[38;5;51m',        // Cyan
  yellow: '\x1b[38;5;220m',     // Yellow
  red: '\x1b[38;5;196m',        // Red
  system: '\x1b[38;5;250m',     // Light gray
  
  // Background colors
  bgGreen: '\x1b[48;5;22m',
  bgBlue: '\x1b[48;5;17m',
  bgPurple: '\x1b[48;5;53m',
  bgOrange: '\x1b[48;5;130m',
  bgCyan: '\x1b[48;5;30m',
  bgYellow: '\x1b[48;5;100m',
  bgRed: '\x1b[48;5;88m',
};

const COLOR_MAP: Record<string, string> = {
  green: COLORS.green,
  blue: COLORS.blue,
  purple: COLORS.purple,
  orange: COLORS.orange,
  cyan: COLORS.cyan,
  yellow: COLORS.yellow,
  red: COLORS.red,
};

const BG_COLOR_MAP: Record<string, string> = {
  green: COLORS.bgGreen,
  blue: COLORS.bgBlue,
  purple: COLORS.bgPurple,
  orange: COLORS.bgOrange,
  cyan: COLORS.bgCyan,
  yellow: COLORS.bgYellow,
  red: COLORS.bgRed,
};

interface AgentConfig {
  name: string;
  type: string;
  color: string;
  bgColor: string;
  emoji: string;
  port?: number;
}

interface AgentConfigEntry {
  id: string;
  type: string;
  keypairFile: string;
  label: string;
  emoji: string;
  color: string;
}

/**
 * Load agents dynamically from agents.config.json
 */
function loadAgents(): Record<string, AgentConfig> {
  const configPath = path.resolve(process.cwd(), 'agents.config.json');
  
  if (!fs.existsSync(configPath)) {
    return {};
  }

  const configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const agents: AgentConfigEntry[] = configData.agents || [];
  
  const result: Record<string, AgentConfig> = {};
  let port = 3001;
  
  for (const agent of agents) {
    // Normalize key from label
    const key = agent.label.toLowerCase().replace(/\s+/g, '-');
    
    // Map type to environment variable type
    let envType = agent.type;
    if (agent.type === 'LIQUIDITY_PROVIDER') envType = 'LP';
    if (agent.type === 'TREND_FOLLOWER') envType = 'TREND';
    
    result[key] = {
      name: agent.label,
      type: envType,
      color: COLOR_MAP[agent.color] || COLORS.green,
      bgColor: BG_COLOR_MAP[agent.color] || COLORS.bgGreen,
      emoji: agent.emoji,
      port: port++,
    };
  }
  
  return result;
}

// Load agents dynamically
const AGENTS: Record<string, AgentConfig> = loadAgents();

class SwarmLauncher {
  private processes: Map<string, ChildProcess> = new Map();
  private brokerProcess?: ChildProcess;
  private isShuttingDown = false;
  private startTime: Date = new Date();
  private readonly BROKER_URL = 'http://localhost:3001';

  constructor() {
    this.setupShutdownHandlers();
  }

  private setupShutdownHandlers(): void {
    // Handle Ctrl+C
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
    
    // Handle uncaught errors
    process.on('uncaughtException', (err) => {
      console.error('Uncaught exception:', err);
      this.shutdown();
    });
  }

  private formatTimestamp(): string {
    const now = new Date();
    return now.toLocaleTimeString('en-US', { 
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  private log(agentKey: string, message: string, isError = false): void {
    const agent = AGENTS[agentKey];
    const timestamp = this.formatTimestamp();
    const prefix = `${COLORS.dim}[${timestamp}]${COLORS.reset}`;
    const agentTag = `${agent.bgColor}${COLORS.bright} ${agent.emoji} ${agent.name.padEnd(18)} ${COLORS.reset}`;
    const color = isError ? '\x1b[38;5;196m' : agent.color;
    
    console.log(`${prefix} ${agentTag} ${color}${message}${COLORS.reset}`);
  }

  private logSystem(message: string): void {
    const timestamp = this.formatTimestamp();
    const prefix = `${COLORS.dim}[${timestamp}]${COLORS.reset}`;
    const systemTag = `${COLORS.bright}\x1b[48;5;240m 🚀 SwarmLauncher${' '.repeat(11)} ${COLORS.reset}`;
    
    console.log(`${prefix} ${systemTag} ${COLORS.system}${message}${COLORS.reset}`);
  }

  private spawnBroker(): ChildProcess {
    this.logSystem('Starting MessageBroker...');
    const proc = spawn('ts-node', ['src/comms/MessageBroker.ts'], {
      env: { ...process.env, FORCE_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    proc.on('exit', (code) => {
      if (!this.isShuttingDown && code !== 0) {
        this.logSystem('Broker crashed, restarting...');
        setTimeout(() => { if (!this.isShuttingDown) this.brokerProcess = this.spawnBroker(); }, 3000);
      }
    });
    return proc;
  }

  private async waitForBroker(): Promise<void> {
    for (let i = 0; i < 30; i++) {
      try {
        await axios.get(`${this.BROKER_URL}/health`, { timeout: 1000 });
        this.logSystem('MessageBroker ready');
        return;
      } catch { await new Promise(r => setTimeout(r, 1000)); }
    }
    throw new Error('MessageBroker failed to start');
  }

  private spawnAgent(agentKey: string): ChildProcess {
    const agent = AGENTS[agentKey];
    this.logSystem(`Starting ${agent.name}...`);
    const proc = spawn('ts-node', ['src/index.ts'], {
      env: {
        ...process.env,
        AGENT_TYPE: agent.type,
        MESSAGE_BROKER_URL: this.BROKER_URL,
        FORCE_COLOR: '1'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Handle stdout
    proc.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().trim().split('\n');
      lines.forEach(line => {
        if (line.trim()) {
          this.log(agentKey, line);
        }
      });
    });

    // Handle stderr
    proc.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().trim().split('\n');
      lines.forEach(line => {
        if (line.trim()) {
          this.log(agentKey, line, true);
        }
      });
    });

    // Handle process exit
    proc.on('exit', (code) => {
      if (!this.isShuttingDown) {
        this.log(agentKey, `Process exited with code ${code}`, code !== 0);
        
        // Auto-restart on crash (unless shutting down)
        if (code !== 0 && code !== null) {
          this.logSystem(`${agent.name} crashed, restarting in 5s...`);
          setTimeout(() => {
            if (!this.isShuttingDown) {
              const newProc = this.spawnAgent(agentKey);
              this.processes.set(agentKey, newProc);
            }
          }, 5000);
        }
      }
    });

    proc.on('error', (err) => {
      this.log(agentKey, `Failed to start: ${err.message}`, true);
    });

    return proc;
  }

  async launch(): Promise<void> {
    // Validate config exists
    const agentKeys = Object.keys(AGENTS);
    if (agentKeys.length === 0) {
      console.error('\n❌ No agents found. Run `npm run init` first.\n');
      process.exit(1);
    }

    console.clear();
    
    // Build dynamic agent list for banner
    const agentList = agentKeys.map(key => {
      const agent = AGENTS[key];
      return `║   ${agent.emoji} ${agent.name.padEnd(18)} - Trading agent`;
    }).join('\n');
    
    // Print banner
    console.log(`
${COLORS.bright}
╔════════════════════════════════════════════════════════════════════╗
║                                                                    ║
║   🤖 AGENT MESH - Swarm Launcher                                   ║
║                                                                    ║
║   Starting ${agentKeys.length} autonomous trading agent${agentKeys.length !== 1 ? 's' : ''} on Solana Devnet${' '.repeat(Math.max(0, 14 - agentKeys.length.toString().length))}║
║                                                                    ║
╠════════════════════════════════════════════════════════════════════╣
${agentList}
║                                                                    ║
╠════════════════════════════════════════════════════════════════════╣
║                                                                    ║
║   Dashboard: http://localhost:3456                                 ║
║   Press Ctrl+C to stop all agents                                  ║
║                                                                    ║
╚════════════════════════════════════════════════════════════════════╝
${COLORS.reset}
    `);

    this.logSystem('Initializing agent swarm...');
    
    // Start MessageBroker first
    this.brokerProcess = this.spawnBroker();
    await this.waitForBroker();
    
    // Start agents: Banker first if present (others depend on it)
    const startOrder = agentKeys.sort((a, b) => {
      // Banker goes first
      if (AGENTS[a].type === 'BANKER') return -1;
      if (AGENTS[b].type === 'BANKER') return 1;
      return 0;
    });
    
    for (const agentKey of startOrder) {
      const proc = this.spawnAgent(agentKey);
      this.processes.set(agentKey, proc);
      await new Promise(r => setTimeout(r, 2000));
    }

    this.logSystem('All agents started successfully!');
    this.logSystem('Dashboard available at http://localhost:3456');
    
    // Print stats periodically
    this.startStatsLoop();
    
    // Print agent balances periodically
    this.startBalanceLoop();
    
    // Keep process alive
    await new Promise(() => {});
  }

  private startStatsLoop(): void {
    const totalAgents = Object.keys(AGENTS).length;
    setInterval(() => {
      const uptime = Math.floor((Date.now() - this.startTime.getTime()) / 1000);
      const hours = Math.floor(uptime / 3600);
      const minutes = Math.floor((uptime % 3600) / 60);
      const seconds = uptime % 60;
      
      const uptimeStr = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
      
      const activeCount = Array.from(this.processes.values()).filter(p => p.exitCode === null).length;
      
      this.logSystem(`Uptime: ${uptimeStr} | Active agents: ${activeCount}/${totalAgents}`);
    }, 60000); // Every minute
  }

  private startBalanceLoop(): void {
    // Show balances immediately
    this.showAgentBalances();
    
    // Then every 30 seconds
    setInterval(() => {
      this.showAgentBalances();
    }, 30000);
  }

  private showAgentBalances(): void {
    const fs = require('fs');
    const path = require('path');
    
    // Try to read transaction log to infer balances
    const logPath = path.join(process.cwd(), 'logs', 'all-transactions.json');
    
    try {
      if (fs.existsSync(logPath)) {
        const data = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
        
        // Calculate net P&L per agent
        const agentStats: Record<string, { trades: number; pnl: number; volume: number }> = {};
        
        for (const tx of data) {
          if (!agentStats[tx.agentId]) {
            agentStats[tx.agentId] = { trades: 0, pnl: 0, volume: 0 };
          }
          agentStats[tx.agentId].trades++;
          agentStats[tx.agentId].volume += tx.solAmount || 0;
          agentStats[tx.agentId].pnl += tx.pnl || 0;
        }
        
        this.logSystem('─'.repeat(70));
        this.logSystem('AGENT BALANCES & PERFORMANCE');
        this.logSystem('─'.repeat(70));
        
        for (const [agentId, stats] of Object.entries(agentStats)) {
          const shortId = agentId.split('-')[0];
          const pnlStr = stats.pnl >= 0 ? `+${stats.pnl.toFixed(4)}` : stats.pnl.toFixed(4);
          this.logSystem(`${shortId.padEnd(12)} Trades: ${stats.trades.toString().padStart(3)} | Volume: ${stats.volume.toFixed(3)} SOL | P&L: ${pnlStr} SOL`);
        }
        
        if (Object.keys(agentStats).length === 0) {
          this.logSystem('No transactions yet. Agents are warming up...');
        }
        
        this.logSystem('─'.repeat(70));
      }
    } catch (err) {
      // Silently ignore errors
    }
  }

  private shutdown(): void {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    console.log('\n');
    this.logSystem('Shutting down agent swarm...');
    
    if (this.brokerProcess) this.brokerProcess.kill('SIGTERM');
    
    for (const [agentKey, proc] of Array.from(this.processes.entries())) {
      const agent = AGENTS[agentKey];
      this.log(agentKey, 'Stopping...');
      try {
        proc.kill('SIGTERM');
        setTimeout(() => { if (proc.exitCode === null) proc.kill('SIGKILL'); }, 5000);
      } catch {}
    }
    
    // Wait a bit for cleanup
    setTimeout(() => {
      this.logSystem('All agents stopped. Goodbye! 👋');
      process.exit(0);
    }, 1000);
  }
}


const launcher = new SwarmLauncher();
launcher.launch().catch(err => {
  console.error('Failed to launch swarm:', err);
  process.exit(1);
});
