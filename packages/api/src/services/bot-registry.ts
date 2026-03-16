/**
 * Bot Registry - Redis 기반 Nexus Bot 엔드포인트 관리
 *
 * 구조: knoxUserId → { endpoint, registeredAt, lastSeen }
 * TTL: 24시간 (bot이 주기적으로 heartbeat → 갱신)
 */

import { Redis } from 'ioredis';
import { config } from '../config.js';
import { wlog } from '../middleware/logger.js';
import type { BotRegistration } from '../types.js';

const KEY_PREFIX = 'bot:';
const BOT_TTL = 86400; // 24시간

let redis: Redis;

export function initRedis(): Redis {
  redis = new Redis(config.redis.url, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times: number) => Math.min(times * 200, 3000),
  });
  redis.on('connect', () => wlog.info('Redis connected'));
  redis.on('error', (err: Error) => wlog.error('Redis error', { error: String(err) }));
  return redis;
}

export function getRedis(): Redis {
  return redis;
}

function safeParse(raw: string): BotRegistration | null {
  try {
    return JSON.parse(raw) as BotRegistration;
  } catch {
    wlog.error('Bot registry: corrupted JSON', { raw: raw.slice(0, 200) });
    return null;
  }
}

// ─── Bot 등록 ───

export async function registerBot(knoxUserId: string, endpoint: string): Promise<void> {
  const reg: BotRegistration = {
    knoxUserId,
    endpoint,
    registeredAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
  };
  await redis.set(`${KEY_PREFIX}${knoxUserId}`, JSON.stringify(reg), 'EX', BOT_TTL);
  wlog.info('Bot registered', { knoxUserId, endpoint });
}

// ─── Bot 해제 ───

export async function unregisterBot(knoxUserId: string): Promise<boolean> {
  const deleted = await redis.del(`${KEY_PREFIX}${knoxUserId}`);
  wlog.info('Bot unregistered', { knoxUserId, found: deleted > 0 });
  return deleted > 0;
}

// ─── Bot 조회 ───

export async function getBot(knoxUserId: string): Promise<BotRegistration | null> {
  const raw = await redis.get(`${KEY_PREFIX}${knoxUserId}`);
  if (!raw) return null;
  return safeParse(raw);
}

// ─── Bot 목록 ───

export async function listBots(): Promise<BotRegistration[]> {
  const keys = await redis.keys(`${KEY_PREFIX}*`);
  if (keys.length === 0) return [];
  const pipeline = redis.pipeline();
  for (const key of keys) pipeline.get(key);
  const results = await pipeline.exec();
  if (!results) return [];
  const bots: BotRegistration[] = [];
  for (const [err, val] of results) {
    if (err || !val) continue;
    const parsed = safeParse(val as string);
    if (parsed) bots.push(parsed);
  }
  return bots;
}

// ─── Heartbeat (TTL 갱신) ───

export async function heartbeat(knoxUserId: string): Promise<boolean> {
  const raw = await redis.get(`${KEY_PREFIX}${knoxUserId}`);
  if (!raw) return false;
  const reg = safeParse(raw);
  if (!reg) return false;
  reg.lastSeen = new Date().toISOString();
  await redis.set(`${KEY_PREFIX}${knoxUserId}`, JSON.stringify(reg), 'EX', BOT_TTL);
  return true;
}
