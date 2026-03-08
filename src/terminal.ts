#!/usr/bin/env ts-node
/**
 * Agent Mesh - Trading Terminal
 * 
 * Runs swarm silently, displays on-chain verified trades only
 */

import { spawn, ChildProcess } from 'child_process';
import axios from 'axios';
import { Connection, PublicKey } from '@solana/web3.js';
import * as fs from 'fs';

const C = {
  reset: '\x1b[0m', bright: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
  white: '\x1b[37m', gray: '\x1b[90m',
  bgGreen: '\x1b[42m', bgBlue: '\x1b[44m', bgYellow: '\x1b[43m', bgMagenta: '\x1b[45m'
};

const AGENTS = {
  banker: { name: 'Banker', type: 'BANKER', emoji: '🏦', sym: 'BNK', bg: C.bgYellow, color: C.yellow },
  arbitrageur: { name: 'Arbitrageur', type: 'ARBITRAGEUR', emoji: '📈', sym: 'ARB', bg: C.bgGreen, color: C.green },
  trend: { name: 'Trend', type: 'TREND', emoji: '📊', sym: 'TRD', bg: C.bgBlue, color: C.blue },
  lp: { name: 'Liquidity', type: 'LP', emoji: '💧', sym: 'LPD', bg: C.bgMagenta, color: C.magenta }
};

const TOKENS = [
  { symbol: 'AUSDC', price: 44.12, change: '+0.5%' },
  { symbol: 'ABTC', price: 0.66, change: '-0.2%' },
  { symbol: 'AETH', price: 5.31, change: '+1.1%' },
  { symbol: 'ASOL', price: 52.78, change: '-0.8%' }
];

interface Trade {
  time: string;
  tx: string;
  agent: string;
  action: string;
  token: string;
  amount: string;
  value: string;
}

class Terminal {
  private processes = new Map<string, ChildProcess>();
  private broker?: ChildProcess;
  private shuttingDown = false;
  private startTime = Date.now();
  private trades: Trade[] = [];
  private agentBalances: Map<string, number> = new Map();
  private connection: Connection;
  private agentWallets: Map<string, string> = new Map();
  private lastSig: Map<string, string> = new Map();
  private readonly BROKER = 'http://localhost:3001';
  private readonly RPC = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';

  constructor() {
    this.connection = new Connection(this.RPC, 'confirmed');
    this.loadWallets();
    process.on('SIGINT', () => this.shutdown());
  }

  private loadWallets() {
    try {
      const reg = JSON.parse(fs.readFileSync('./wallet-registry.json', 'utf-8'));
      for (const a of reg.agents) this.agentWallets.set(a.id, a.publicKey);
    } catch {}
  }

  private time() {
    return new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  private uptime() {
    const s = Math.floor((Date.now() - this.startTime) / 1000);
    return `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;
  }

  private clear() {
    console.clear();
  }

  private banner() {
    console.log(`${C.bright}╔══════════════════════════════════════════════════════════════════════════════╗${C.reset}`);
    console.log(`${C.bright}║  🤖 AGENT MESH - TRADING TERMINAL                          Uptime: ${this.uptime().padStart(5)}  ║${C.reset}`);
    console.log(`${C.bright}╚══════════════════════════════════════════════════════════════════════════════╝${C.reset}`);
  }

  private ticker() {
    let line = `${C.gray}`;
    for (const t of TOKENS) {
      const color = t.change.startsWith('+') ? C.green : C.red;
      line += `  ${C.bright}${t.symbol}${C.reset}${C.gray} $${t.price.toFixed(2)} ${color}${t.change}${C.reset}${C.gray} │`;
    }
    console.log(line + C.reset);
    console.log(`${C.gray}${'─'.repeat(80)}${C.reset}`);
  }

  private agentStatus() {
    console.log(`\n${C.bright}AGENT STATUS${C.reset}`);
    console.log(`${C.gray}┌───────────────┬──────────┬───────────────┬──────────┬──────────────┐${C.reset}`);
    console.log(`${C.gray}│${C.reset} ${C.bright}Agent${C.reset}         ${C.gray}│${C.reset} ${C.bright}Status${C.reset}   ${C.gray}│${C.reset} ${C.bright}SOL Balance${C.reset}   ${C.gray}│${C.reset} ${C.bright}Trades${C.reset}   ${C.gray}│${C.reset} ${C.bright}P&L${C.reset}          ${C.gray}│${C.reset}`);
    console.log(`${C.gray}├───────────────┼──────────┼───────────────┼──────────┼──────────────┤${C.reset}`);

    for (const [key, a] of Object.entries(AGENTS)) {
      const isUp = this.processes.get(key)?.exitCode === null;
      const status = isUp ? `${C.green}● ONLINE${C.reset}` : `${C.red}● OFFLINE${C.reset}`;
      const bal = (this.agentBalances.get(key) || 0).toFixed(4);
      const trades = this.trades.filter(t => t.agent === a.sym).length;
      const pnl = this.trades.filter(t => t.agent === a.sym).reduce((s, t) => s + (parseFloat(t.value) || 0), 0);
      const pnlStr = pnl >= 0 ? `${C.green}+${pnl.toFixed(4)}${C.reset}` : `${C.red}${pnl.toFixed(4)}${C.reset}`;
      
      console.log(`${C.gray}│${C.reset} ${a.color}${a.emoji} ${a.name.padEnd(11)}${C.reset}${C.gray}│${C.reset} ${status.padEnd(17)}${C.gray}│${C.reset} ${bal.padStart(13)} ${C.gray}│${C.reset} ${trades.toString().padStart(8)} ${C.gray}│${C.reset} ${pnlStr.padStart(12)} ${C.gray}│${C.reset}`);
    }
    console.log(`${C.gray}└───────────────┴──────────┴───────────────┴──────────┴──────────────┘${C.reset}`);
  }

  private tradeTable() {
    console.log(`\n${C.bright}ON-CHAIN VERIFIED TRADES${C.reset}`);
    
    if (this.trades.length === 0) {
      console.log(`${C.gray}Waiting for trades...${C.reset}`);
      return;
    }

    console.log(`${C.gray}Time       Agent  Action Token   Amount        Value      Tx${C.reset}`);
    console.log(`${C.gray}────────── ────── ────── ─────── ───────────── ────────── ──────────────────────────${C.reset}`);
    
    for (const t of this.trades.slice(0, 10)) {
      const actColor = t.action === 'BUY' ? C.green : C.red;
      const tx = t.tx.slice(0, 26) + '...';
      console.log(`${t.time} ${C.gray}${t.agent}${C.reset} ${actColor}${t.action}${C.reset} ${t.token.padEnd(7)} ${t.amount.padStart(13)} ${t.value.padStart(10)} ${C.gray}${tx}${C.reset}`);
    }
  }

  private footer() {
    console.log(`\n${C.gray}${'─'.repeat(80)}${C.reset}`);
    console.log(`${C.gray}Ctrl+C to exit │ Dashboard: http://localhost:3456 │ Auto-refresh: 30s${C.reset}`);
  }

  private render() {
    this.clear();
    this.banner();
    this.ticker();
    this.agentStatus();
    this.tradeTable();
    this.footer();
  }

  private async checkOnChain() {
    for (const [id, pubkey] of Array.from(this.agentWallets.entries())) {
      try {
        // Get SOL balance
        const bal = await this.connection.getBalance(new PublicKey(pubkey));
        const key = id.split('-')[0];
        this.agentBalances.set(key === 'trend' ? 'trend' : key === 'arbitrageur' ? 'arbitrageur' : key === 'liquidity' ? 'lp' : 'banker', bal / 1e9);

        // Get recent signatures
        const sigs = await this.connection.getSignaturesForAddress(new PublicKey(pubkey), { limit: 3 });
        for (const sig of sigs) {
          if (this.lastSig.get(id) === sig.signature) continue;
          this.lastSig.set(id, sig.signature);

          // Only check recent txs (< 60s)
          if (!sig.blockTime || Date.now() - sig.blockTime * 1000 > 60000) continue;

          // Get tx details
          const tx = await this.connection.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0 });
          if (!tx?.meta) continue;

          // Check for swap (look at token changes or balance changes)
          const pre = tx.meta.preBalances;
          const post = tx.meta.postBalances;
          const idx = tx.transaction.message.accountKeys.findIndex((a: any) => 
            (a.pubkey?.toString() || a.toString()) === pubkey
          );

          if (idx >= 0) {
            const change = (post[idx] - pre[idx]) / 1e9;
            if (Math.abs(change) > 0.001) {
              const agentKey = id.includes('trend') ? 'trend' : id.includes('arbitrageur') ? 'arbitrageur' : id.includes('liquidity') ? 'lp' : 'banker';
              const agent = AGENTS[agentKey as keyof typeof AGENTS];
              
              this.trades.unshift({
                time: this.time(),
                tx: sig.signature,
                agent: agent.sym,
                action: change > 0 ? 'SELL' : 'BUY',
                token: 'POOL',
                amount: `${Math.abs(change).toFixed(4)} SOL`,
                value: change.toFixed(6)
              });
              
              if (this.trades.length > 50) this.trades.pop();
            }
          }
        }
      } catch {}
    }
  }

  private spawnSilent(key: string) {
    const a = AGENTS[key as keyof typeof AGENTS];
    return spawn('ts-node', ['src/index.ts'], {
      env: { ...process.env, AGENT_TYPE: a.type, MESSAGE_BROKER_URL: this.BROKER },
      stdio: 'ignore' // Silent - no output
    });
  }

  private spawnBroker() {
    return spawn('ts-node', ['src/comms/MessageBroker.ts'], { stdio: 'ignore' });
  }

  private async waitBroker() {
    for (let i = 0; i < 30; i++) {
      try { await axios.get(`${this.BROKER}/health`, { timeout: 1000 }); return; } catch { await new Promise(r => setTimeout(r, 1000)); }
    }
  }

  async launch() {
    this.render();

    // Start broker
    this.broker = this.spawnBroker();
    await this.waitBroker();

    // Start agents silently
    for (const k of ['banker', 'arbitrageur', 'trend', 'lp']) {
      this.processes.set(k, this.spawnSilent(k));
      await new Promise(r => setTimeout(r, 2000));
    }

    // Initial render
    this.render();

    // Poll on-chain every 30 seconds
    setInterval(() => {
      this.checkOnChain();
      this.render();
    }, 30000);

    // Refresh display every 5 seconds for uptime
    setInterval(() => this.render(), 5000);

    await new Promise(() => {});
  }

  private shutdown() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.broker?.kill();
    this.processes.forEach(p => p.kill());
    setTimeout(() => process.exit(0), 500);
  }
}

new Terminal().launch();
