/**
 * MessageBus - Agent Communication Layer
 * 
 * Enables agents to broadcast opportunities, risks, and coordination signals
 * Now with cross-process support via HTTP MessageBroker
 * 
 * Usage:
 *   1. Start MessageBroker: npx ts-node src/comms/MessageBroker.ts
 *   2. Agents auto-connect and communicate across processes
 */

import { EventEmitter } from 'events';
import axios from 'axios';

export type MessageType = 
  | 'OPPORTUNITY'      // Price discrepancy found
  | 'TRADE_EXECUTED'   // Trade completed
  | 'RISK_ALERT'       // Market risk warning
  | 'LIQUIDITY_REQUEST' // Request for liquidity
  | 'LIQUIDITY_UPDATE' // Liquidity added/removed
  | 'LOAN_OFFER'       // Lending offer
  | 'LOAN_REQUEST'     // Borrowing request
  | 'LOAN_ISSUED'      // Loan has been issued
  | 'LOAN_REPAYMENT'   // Loan repayment
  | 'PRICE_UPDATE'     // Significant price movement
  | 'FUND_REQUEST'     // Request for funds from Banker
  | 'FUNDS_SENT'       // Funds transferred
  | 'FUND_REJECTED'    // Fund request denied
  | 'FUND_OFFER'       // Proactive fund offer
  | 'FUNDS_REPAYMENT'; // Repayment to Banker

export interface AgentMessage {
  id: string;
  from: string;
  to: string | 'broadcast';
  type: MessageType;
  payload: any;
  timestamp: Date;
  ttl: number; // Time to live (ms)
}

interface MessageBusConfig {
  brokerUrl?: string;
  useInMemory?: boolean;
  pollingInterval?: number;
}

export class MessageBus extends EventEmitter {
  private static instance: MessageBus;
  private messages: AgentMessage[] = [];
  private agentSubscriptions: Map<string, Set<MessageType>> = new Map();
  private readonly MAX_MESSAGES = 100;
  private readonly DEFAULT_TTL = 60000; // 1 minute
  
  // Cross-process support
  private brokerUrl: string;
  private useInMemory: boolean;
  private pollingInterval: number;
  private pollingTimer?: NodeJS.Timeout;
  private agentId?: string;

  static getInstance(config?: MessageBusConfig): MessageBus {
    if (!MessageBus.instance) {
      MessageBus.instance = new MessageBus(config);
    }
    return MessageBus.instance;
  }

  private constructor(config: MessageBusConfig = {}) {
    super();
    this.brokerUrl = config.brokerUrl || process.env.MESSAGE_BROKER_URL || 'http://localhost:3001';
    this.useInMemory = config.useInMemory || false;
    this.pollingInterval = config.pollingInterval || 2000; // Poll every 2 seconds
    
    // Use in-memory mode if broker unavailable
    if (!this.useInMemory) {
      this.checkBrokerConnection();
    }
  }

  private async checkBrokerConnection(): Promise<void> {
    try {
      await axios.get(`${this.brokerUrl}/health`, { timeout: 2000 });
      console.log(`[MessageBus] ✅ Connected to broker at ${this.brokerUrl}`);
      this.useInMemory = false;
    } catch {
      console.log(`[MessageBus] ⚠️  Broker not available, using in-memory mode (no cross-process comms)`);
      console.log(`[MessageBus]    Start broker with: npx ts-node src/comms/MessageBroker.ts`);
      this.useInMemory = true;
    }
  }

  subscribe(agentId: string, types: MessageType[]): void {
    this.agentSubscriptions.set(agentId, new Set(types));
    this.agentId = agentId;
    
    console.log(`[MessageBus] ${agentId} subscribed to: ${types.join(', ')}`);
    
    // Start polling if using broker
    if (!this.useInMemory && !this.pollingTimer) {
      this.startPolling(agentId, types);
    }
  }

  private startPolling(agentId: string, types: MessageType[]): void {
    const poll = async () => {
      try {
        const typesParam = types.join(',');
        const response = await axios.get(
          `${this.brokerUrl}/messages/${agentId}?types=${typesParam}`,
          { timeout: 5000 }
        );
        
        const messages: AgentMessage[] = response.data.messages;
        messages.forEach(msg => {
          this.emit('message', msg);
          if (msg.to === 'broadcast') {
            this.emit('broadcast', msg);
          } else {
            this.emit(`to:${msg.to}`, msg);
          }
        });
      } catch (err) {
        // Silent fail - broker might be temporarily unavailable
      }
    };
    
    // Poll immediately and then on interval
    poll();
    this.pollingTimer = setInterval(poll, this.pollingInterval);
  }

  unsubscribe(agentId: string): void {
    this.agentSubscriptions.delete(agentId);
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = undefined;
    }
  }

  async broadcast(message: Omit<AgentMessage, 'id' | 'timestamp' | 'ttl'>): Promise<void> {
    const fullMessage: AgentMessage = {
      ...message,
      id: this.generateId(),
      timestamp: new Date(),
      ttl: this.DEFAULT_TTL,
    };

    // Always store locally for getMessagesForAgent
    this.messages.push(fullMessage);
    this.cleanup();

    // Emit locally
    if (message.to === 'broadcast') {
      this.emit('broadcast', fullMessage);
      console.log(`[MessageBus] 📢 BROADCAST from ${message.from}: ${message.type}`);
    } else {
      this.emit(`to:${message.to}`, fullMessage);
      console.log(`[MessageBus] 📨 DIRECT from ${message.from} to ${message.to}: ${message.type}`);
    }

    // Send to broker for cross-process communication
    if (!this.useInMemory) {
      try {
        await axios.post(`${this.brokerUrl}/publish`, message, { timeout: 3000 });
      } catch (err) {
        // Fallback to in-memory if broker fails
        console.log(`[MessageBus] ⚠️  Broker unreachable, message only sent locally`);
      }
    }

    // Log payload summary
    this.logPayload(fullMessage);
  }

  getMessagesForAgent(agentId: string): AgentMessage[] {
    const subscribedTypes = this.agentSubscriptions.get(agentId);
    if (!subscribedTypes) return [];

    return this.messages.filter(msg => {
      const isRecipient = msg.to === 'broadcast' || msg.to === agentId;
      const isSubscribed = subscribedTypes.has(msg.type);
      const isFresh = Date.now() - msg.timestamp.getTime() < msg.ttl;
      
      return isRecipient && isSubscribed && isFresh && msg.from !== agentId;
    });
  }

  getRecentOpportunities(limit: number = 5): AgentMessage[] {
    return this.messages
      .filter(m => m.type === 'OPPORTUNITY')
      .slice(-limit);
  }

  getMarketSentiment(): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
    const recent = this.messages.slice(-20);
    const opportunities = recent.filter(m => m.type === 'OPPORTUNITY').length;
    const risks = recent.filter(m => m.type === 'RISK_ALERT').length;
    
    if (opportunities > risks * 2) return 'BULLISH';
    if (risks > opportunities * 2) return 'BEARISH';
    return 'NEUTRAL';
  }

  async getBrokerStatus(): Promise<{ connected: boolean; url: string }> {
    if (this.useInMemory) {
      return { connected: false, url: this.brokerUrl };
    }
    try {
      await axios.get(`${this.brokerUrl}/health`, { timeout: 2000 });
      return { connected: true, url: this.brokerUrl };
    } catch {
      return { connected: false, url: this.brokerUrl };
    }
  }

  private generateId(): string {
    return Math.random().toString(36).substring(2, 15);
  }

  private cleanup(): void {
    const now = Date.now();
    this.messages = this.messages.filter(m => 
      now - m.timestamp.getTime() < m.ttl
    );
    
    if (this.messages.length > this.MAX_MESSAGES) {
      this.messages = this.messages.slice(-this.MAX_MESSAGES);
    }
  }

  private logPayload(message: AgentMessage): void {
    const payload = message.payload;
    switch (message.type) {
      case 'OPPORTUNITY':
        console.log(`           💰 ${payload.token}: ${payload.direction} @ ${payload.price} (${payload.confidence}% confidence)`);
        break;
      case 'TRADE_EXECUTED':
        console.log(`           ✅ ${payload.action} ${payload.amount} ${payload.token}`);
        break;
      case 'RISK_ALERT':
        console.log(`           ⚠️  ${payload.severity}: ${payload.reason}`);
        break;
      case 'LIQUIDITY_REQUEST':
        console.log(`           💧 Need ${payload.amount} SOL in ${payload.pool}`);
        break;
      case 'LOAN_OFFER':
        console.log(`           🏦 Offering ${payload.amount} SOL @ ${payload.interestRate}% interest`);
        break;
      case 'LOAN_REQUEST':
        console.log(`           📥 Requesting ${payload.amount} SOL for ${payload.duration}h`);
        break;
      case 'FUND_REQUEST':
        console.log(`           🏦 Requesting ${payload.amount} SOL - ${payload.reason}`);
        break;
      case 'FUNDS_SENT':
        console.log(`           ✅ Sent ${payload.amount} ${payload.token}`);
        break;
      case 'FUND_REJECTED':
        console.log(`           ❌ Request denied: ${payload.reason}`);
        break;
      case 'FUND_OFFER':
        console.log(`           🎁 Offering ${payload.amount} ${payload.token}`);
        break;
    }
  }

  async printStatus(): Promise<void> {
    const brokerStatus = await this.getBrokerStatus();
    
    console.log('\n📡 MessageBus Status:');
    console.log(`   Mode: ${this.useInMemory ? 'In-Memory' : 'HTTP Broker'}`);
    console.log(`   Broker: ${brokerStatus.url} (${brokerStatus.connected ? 'connected' : 'disconnected'})`);
    console.log(`   Active messages: ${this.messages.length}`);
    console.log(`   Subscribed agents: ${this.agentSubscriptions.size}`);
    console.log(`   Market sentiment: ${this.getMarketSentiment()}`);
    
    const recent = this.getRecentOpportunities(3);
    if (recent.length > 0) {
      console.log('   Recent opportunities:');
      recent.forEach(m => {
        console.log(`     • ${m.from}: ${m.payload.token} ${m.payload.direction}`);
      });
    }
  }
}

// Singleton export
export const messageBus = MessageBus.getInstance();
