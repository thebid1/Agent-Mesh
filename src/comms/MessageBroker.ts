/**
 * MessageBroker - HTTP-based Inter-Process Communication
 * 
 * Lightweight Express server that enables agents running in separate
 * processes to communicate via HTTP polling.
 * 
 * Run this before starting agents: npx ts-node src/comms/MessageBroker.ts
 */

import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { AgentMessage, MessageType } from './MessageBus';

const DEFAULT_PORT = 3001;
const MESSAGES_FILE = './logs/message-bus.json';

interface StoredMessage extends AgentMessage {
  deliveredTo: string[]; // Track which agents have received this message
}

class MessageBroker {
  private app = express();
  private messages: StoredMessage[] = [];
  private readonly MAX_MESSAGES = 200;
  private readonly DEFAULT_TTL = 60000; // 1 minute
  private port: number;

  constructor(port: number = DEFAULT_PORT) {
    this.port = port;
    this.setupMiddleware();
    this.setupRoutes();
    this.loadMessages();
    
    // Cleanup every 30s
    setInterval(() => this.cleanup(), 30000);
    
    // Persist every 10s
    setInterval(() => this.saveMessages(), 10000);
  }

  private setupMiddleware(): void {
    this.app.use(cors());
    this.app.use(express.json());
  }

  private setupRoutes(): void {

    this.app.get('/health', (req, res) => {
      res.json({ 
        status: 'ok', 
        messages: this.messages.length,
        uptime: process.uptime()
      });
    });


    this.app.post('/publish', (req, res) => {
      const message: Omit<AgentMessage, 'id' | 'timestamp' | 'ttl'> = req.body;
      
      if (!message.from || !message.type) {
        res.status(400).json({ error: 'Missing required fields: from, type' });
        return;
      }

      const fullMessage: StoredMessage = {
        ...message,
        id: this.generateId(),
        timestamp: new Date(),
        ttl: this.DEFAULT_TTL,
        deliveredTo: [],
      };

      this.messages.push(fullMessage);
      this.cleanup();
      
      console.log(`[Broker] 📢 ${message.from} → ${message.to || 'broadcast'}: ${message.type}`);
      
      res.json({ success: true, messageId: fullMessage.id });
    });

    // Get messages for an agent (with acknowledgement)
    this.app.get('/messages/:agentId', (req, res) => {
      const { agentId } = req.params;
      const subscribedTypes = req.query.types?.toString().split(',') as MessageType[] || [];
      
      const now = Date.now();
      const relevantMessages = this.messages.filter(msg => {
        // Check TTL
        if (now - new Date(msg.timestamp).getTime() > msg.ttl) return false;
        
        // Deduplicate
        if (msg.deliveredTo.includes(agentId)) return false;
        
        // Filter by recipient
        const isRecipient = msg.to === 'broadcast' || msg.to === agentId;
        if (!isRecipient) return false;
        
        // Check subscription types
        if (subscribedTypes.length > 0 && !subscribedTypes.includes(msg.type)) return false;
        
        // Don't return messages from self
        if (msg.from === agentId) return false;
        
        return true;
      });

      // Mark messages as delivered
      relevantMessages.forEach(msg => {
        msg.deliveredTo.push(agentId);
      });

      res.json({ messages: relevantMessages });
    });

    // Get all recent messages (for debugging)
    this.app.get('/messages', (req, res) => {
      const limit = parseInt(req.query.limit?.toString() || '50');
      res.json({ 
        messages: this.messages.slice(-limit),
        total: this.messages.length 
      });
    });

    // Get recent opportunities
    this.app.get('/opportunities', (req, res) => {
      const limit = parseInt(req.query.limit?.toString() || '5');
      const opportunities = this.messages
        .filter(m => m.type === 'OPPORTUNITY')
        .slice(-limit);
      res.json({ opportunities });
    });

    // Get market sentiment
    this.app.get('/sentiment', (req, res) => {
      const recent = this.messages.slice(-20);
      const opportunities = recent.filter(m => m.type === 'OPPORTUNITY').length;
      const risks = recent.filter(m => m.type === 'RISK_ALERT').length;
      
      let sentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
      if (opportunities > risks * 2) sentiment = 'BULLISH';
      if (risks > opportunities * 2) sentiment = 'BEARISH';
      
      res.json({ sentiment, opportunities, risks });
    });

    // Clear all messages (for testing)
    this.app.post('/clear', (req, res) => {
      this.messages = [];
      res.json({ success: true });
    });
  }

  private generateId(): string {
    return Math.random().toString(36).substring(2, 15);
  }

  private cleanup(): void {
    const now = Date.now();
    this.messages = this.messages.filter(m => {
      // Keep if TTL not expired
      const isFresh = now - new Date(m.timestamp).getTime() < m.ttl;
      // Keep if not everyone has received it yet
      const notFullyDelivered = m.deliveredTo.length < 4; // Assume max 4 agents
      return isFresh || notFullyDelivered;
    });

    // Hard limit
    if (this.messages.length > this.MAX_MESSAGES) {
      this.messages = this.messages.slice(-this.MAX_MESSAGES);
    }
  }

  private saveMessages(): void {
    try {
      const dir = path.dirname(MESSAGES_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(MESSAGES_FILE, JSON.stringify(this.messages, null, 2));
    } catch (err) {
      // Silent fail - not critical
    }
  }

  private loadMessages(): void {
    try {
      if (fs.existsSync(MESSAGES_FILE)) {
        const data = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf-8'));
        this.messages = data.map((m: any) => ({
          ...m,
          deliveredTo: [], // Reset delivery tracking on restart
        }));
      }
    } catch (err) {
      // Silent fail - not critical
    }
  }

  start(): void {
    this.app.listen(this.port, () => {
      console.log('='.repeat(60));
      console.log('  MessageBroker Started');
      console.log('='.repeat(60));
      console.log(`  Port: ${this.port}`);
      console.log(`  Health: http://localhost:${this.port}/health`);
      console.log(`  Messages: http://localhost:${this.port}/messages`);
      console.log('='.repeat(60));
    });
  }
}

// Start if run directly
if (require.main === module) {
  const port = parseInt(process.env.MESSAGE_BROKER_PORT || '3001');
  const broker = new MessageBroker(port);
  broker.start();
}

export { MessageBroker };
