#!/usr/bin/env ts-node
/**
 * Debug Terminal - Shows raw agent output
 */

import { spawn } from 'child_process';

const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

const AGENTS = [
  { name: 'Banker', type: 'BANKER', color: COLORS.yellow },
  { name: 'Arbitrageur', type: 'ARBITRAGEUR', color: COLORS.green },
  { name: 'Trend', type: 'TREND', color: COLORS.blue },
  { name: 'LP', type: 'LP', color: COLORS.magenta },
];

console.log('🔍 DEBUG TERMINAL - Raw Agent Output');
console.log('=' .repeat(80));

// Start MessageBroker first
console.log('[SYSTEM] Starting MessageBroker...');
const broker = spawn('ts-node', ['src/comms/MessageBroker.ts'], {
  stdio: ['ignore', 'pipe', 'pipe']
});

broker.stdout?.on('data', (d) => console.log(`[BROKER] ${d.toString().trim()}`));
broker.stderr?.on('data', (d) => console.log(`${COLORS.red}[BROKER ERR]${COLORS.reset} ${d.toString().trim()}`));

// Wait for broker then start agents
setTimeout(() => {
  AGENTS.forEach((agent, i) => {
    setTimeout(() => {
      console.log(`[SYSTEM] Starting ${agent.name}...`);
      
      const proc = spawn('ts-node', ['src/index.ts'], {
        env: { ...process.env, AGENT_TYPE: agent.type },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      proc.stdout?.on('data', (data) => {
        const lines = data.toString().split('\n');
        lines.forEach((line: string) => {
          if (line.trim()) {
            console.log(`${agent.color}[${agent.name}]${COLORS.reset} ${line}`);
          }
        });
      });
      
      proc.stderr?.on('data', (data) => {
        const lines = data.toString().split('\n');
        lines.forEach((line: string) => {
          if (line.trim()) {
            console.log(`${COLORS.red}[${agent.name} ERR]${COLORS.reset} ${line}`);
          }
        });
      });
      
      proc.on('exit', (code) => {
        console.log(`${COLORS.red}[SYSTEM] ${agent.name} exited with code ${code}${COLORS.reset}`);
      });
      
    }, i * 3000);
  });
}, 5000);

// Keep alive
setInterval(() => {}, 1000);

process.on('SIGINT', () => {
  console.log('\n[SYSTEM] Shutting down...');
  process.exit(0);
});
