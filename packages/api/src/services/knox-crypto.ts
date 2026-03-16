/**
 * Knox Messenger AES256 + Base64 암복호화
 *
 * Knox 키 포맷: 96 hex chars (48 bytes) = AES256 key(32B) + IV(16B)
 * 암호화: plaintext → AES-256-CBC → Base64
 * 복호화: Base64 → AES-256-CBC → plaintext
 */

import crypto from 'crypto';
import { config } from '../config.js';
import { wlog } from '../middleware/logger.js';

const ALGO = 'aes-256-cbc';

function parseKey(hexKey: string): { key: Buffer; iv: Buffer } {
  if (!hexKey || hexKey.length < 96 || !/^[0-9a-fA-F]+$/.test(hexKey)) {
    throw new Error(`Invalid encryption key: expected 96 hex chars, got ${hexKey?.length || 0} (valid hex: ${/^[0-9a-fA-F]+$/.test(hexKey || '')})`);
  }
  const raw = Buffer.from(hexKey, 'hex'); // 48 bytes
  return {
    key: raw.subarray(0, 32),
    iv: raw.subarray(32, 48),
  };
}

export function encrypt(plaintext: string, hexKey?: string): string {
  const { key, iv } = parseKey(hexKey || config.knox.encryptionKey);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return encrypted.toString('base64');
}

export function decrypt(ciphertext: string, hexKey?: string): string {
  const { key, iv } = parseKey(hexKey || config.knox.encryptionKey);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

/**
 * 암호화된 Knox payload → JSON 파싱
 */
export function decryptPayload<T>(encryptedBody: string): T | null {
  try {
    const json = decrypt(encryptedBody);
    return JSON.parse(json) as T;
  } catch (err) {
    wlog.error('Failed to decrypt payload', { error: String(err) });
    return null;
  }
}

/**
 * JSON → 암호화된 Knox payload
 */
export function encryptPayload(data: unknown): string {
  return encrypt(JSON.stringify(data));
}
