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
  // 정상 heartbeat → 실패 카운트 초기화
  await redis.del(`${FAIL_PREFIX}${knoxUserId}`);
  return true;
}

// ─── Forward 실패 카운트 관리 ───

const FAIL_PREFIX = 'bot-fail:';
const MAX_FORWARD_FAILURES = 3;

/** 봇 forward 실패 기록. 연속 3회 실패 시 봇 자동 제거 후 true 반환 */
export async function recordForwardFailure(knoxUserId: string): Promise<boolean> {
  const key = `${FAIL_PREFIX}${knoxUserId}`;
  const count = await redis.incr(key);
  await redis.expire(key, 600); // 10분 내 연속 실패만 카운트
  if (count >= MAX_FORWARD_FAILURES) {
    await unregisterBot(knoxUserId);
    await redis.del(key);
    wlog.warn('Bot auto-removed after consecutive forward failures', { knoxUserId, failCount: count });
    return true;
  }
  return false;
}

/** 봇 forward 성공 시 실패 카운트 초기화 */
export async function resetForwardFailure(knoxUserId: string): Promise<void> {
  await redis.del(`${FAIL_PREFIX}${knoxUserId}`);
}
