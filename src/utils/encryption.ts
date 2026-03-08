/**
 * Encryption Utilities for Secure Key Storage
 * Uses AES-256-GCM for authenticated encryption
 */

import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const SALT_LENGTH = 32;
const TAG_LENGTH = 16;

export interface EncryptedData {
  encrypted: string;  // base64
  iv: string;         // base64
  salt: string;       // base64
  tag: string;        // base64
  version: number;
}

function deriveKey(password: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(password, salt, 100000, KEY_LENGTH, 'sha256');
}

export function encrypt(data: string, password: string): EncryptedData {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = deriveKey(password, salt);
  
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  
  return {
    encrypted: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    salt: salt.toString('base64'),
    tag: tag.toString('base64'),
    version: 1,
  };
}

export function decrypt(encryptedData: EncryptedData, password: string): string {
  if (encryptedData.version !== 1) {
    throw new Error(`Unsupported encryption version: ${encryptedData.version}`);
  }
  
  const salt = Buffer.from(encryptedData.salt, 'base64');
  const iv = Buffer.from(encryptedData.iv, 'base64');
  const encrypted = Buffer.from(encryptedData.encrypted, 'base64');
  const tag = Buffer.from(encryptedData.tag, 'base64');
  
  const key = deriveKey(password, salt);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

export function encryptKeypair(secretKey: Uint8Array, password: string): EncryptedData {
  const keyData = JSON.stringify(Array.from(secretKey));
  return encrypt(keyData, password);
}

export function decryptKeypair(encryptedData: EncryptedData, password: string): Uint8Array {
  const keyData = decrypt(encryptedData, password);
  return new Uint8Array(JSON.parse(keyData));
}

export function generateEncryptionKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function isValidEncryptionKey(key: string): boolean {
  return /^[a-f0-9]{64}$/i.test(key);
}
