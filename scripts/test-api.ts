#!/usr/bin/env ts-node
/**
 * Test Dashboard API
 * 
 * Shows the API endpoints and current data
 */

import * as http from 'http';

const PORT = process.env.DASHBOARD_PORT || 3456;
const HOST = 'localhost';

function fetch(path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: HOST,
      port: PORT,
      path,
      method: 'GET'
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

async function main() {
  console.log('🧪 Testing Dashboard API\n');
  console.log(`URL: http://${HOST}:${PORT}/api\n`);

  try {
    // Test health endpoint
    console.log('1. Health Check:');
    const health = await fetch('/api/health');
    console.log(`   Status: ${health.status}`);
    console.log(`   Port: ${health.port}`);
    console.log(`   Logs Dir: ${health.logsDir ? '✅' : '❌'}`);
    console.log(`   TX File: ${health.transactionsFile ? '✅' : '❌'}\n`);

    // Test API info
    console.log('2. API Info:');
    const info = await fetch('/api');
    console.log(`   ${info.message} v${info.version}\n`);

    // Test stats
    console.log('3. Dashboard Stats:');
    const stats = await fetch('/api/stats');
    console.log(`   Total Trades: ${stats.totalTrades}`);
    console.log(`   Total Volume: ${stats.totalVolume.toFixed(4)} SOL`);
    console.log(`   Total P&L: ${stats.totalPnL.toFixed(6)} SOL`);
    console.log(`   Active Agents: ${stats.activeAgents}\n`);

    // Test transactions
    console.log('4. Recent Transactions:');
    const txs = await fetch('/api/transactions');
    console.log(`   Count: ${txs.length}`);
    if (txs.length > 0) {
      console.log(`   Latest: ${txs[0].agentId} ${txs[0].action} ${txs[0].token}`);
      console.log(`   Time: ${new Date(txs[0].timestamp).toLocaleTimeString()}`);
    }
    console.log();

    // Test agents
    console.log('5. Agent Status:');
    const agents = await fetch('/api/agents');
    for (const agent of agents) {
      console.log(`   ${agent.emoji} ${agent.name} - ${agent.status} (${agent.recentTrades} trades/hour)`);
    }

    // Test balances (real blockchain data)
    console.log('\n6. Agent Balances (from blockchain):');
    try {
      const balances: Record<string, any> = await fetch('/api/balances');
      for (const [agentId, data] of Object.entries(balances)) {
        if (data.error) {
          console.log(`   ${agentId}: ${data.error}`);
        } else {
          console.log(`   ${agentId}:`);
          console.log(`     SOL: ${(data.sol as number).toFixed(4)}`);
          console.log(`     Public Key: ${data.publicKey}`);
          if (data.tokens) {
            const tokens = Object.entries(data.tokens as Record<string, number>)
              .filter(([_, v]) => (v as number) > 0)
              .map(([s, v]) => `${s}: ${Number(v).toFixed(2)}`)
              .join(', ');
            if (tokens) console.log(`     Tokens: ${tokens}`);
          }
        }
      }
    } catch (e) {
      console.log('   Could not fetch balances (keypairs may not exist)');
    }

    console.log('\n✅ API is working with REAL data!');
    console.log(`\n📊 Open dashboard: http://${HOST}:${PORT}`);

  } catch (error: any) {
    console.error('❌ API Error:', error.message);
    console.log('\nIs the dashboard running?');
    console.log('Start it with: npm run dashboard');
  }
}

main();
