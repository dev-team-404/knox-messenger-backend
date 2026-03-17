/**
 * Knox Messenger API Client
 *
 * - 디바이스 등록 (GET /messenger/contact/api/v2.0/device/o1/reg)
 * - 암호화 키 조회 (GET /messenger/msgctx/api/v2.0/key/getkeys)
 * - 대화방 생성 (POST /messenger/message/api/v2.0/message/createChatroomRequest)
 * - 메시지 발신 (POST /messenger/message/api/v2.0/message/chatRequest)
 */

import { config } from '../config.js';
import { encryptPayload, decryptPayload } from './knox-crypto.js';
import { wlog } from '../middleware/logger.js';
import type { KnoxChatRequestBody, KnoxCreateChatroomBody } from '../types.js';

function knoxHeaders(): Record<string, string> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.knox.accessToken}`,
    'System-ID': config.knox.systemId,
    'x-device-id': config.knox.deviceId,
    'x-device-type': 'relation',
  };
}

async function knoxFetch(path: string, options?: RequestInit): Promise<Response> {
  const url = `${config.knox.apiBaseUrl}${path}`;
  wlog.info('Knox API call', { method: options?.method || 'GET', path });
  const res = await fetch(url, { ...options, headers: { ...knoxHeaders(), ...options?.headers } });
  if (!res.ok) {
    // body를 소비하지 않음 — caller가 읽어야 하므로 status만 로깅
    wlog.error('Knox API error', { status: res.status, path });
  }
  return res;
}

/**
 * Knox 응답 복호화 — JSON string 래핑과 raw string 모두 처리
 */
function decryptResponse<T>(rawText: string): T | null {
  // 1차: 따옴표로 감싸져 있으면 벗긴 후 복호화
  let text = rawText.trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    try { text = JSON.parse(text) as string; } catch { /* 그대로 사용 */ }
  }
  return decryptPayload<T>(text);
}

// ─── Knox 초기화 (서버 시작 시 1회) ───

export async function initKnoxApi(): Promise<void> {
  if (!config.knox.apiBaseUrl || !config.knox.accessToken) {
    wlog.warn('Knox API not configured — skipping initialization');
    return;
  }

  // 1. Device 미등록이면 등록
  if (!config.knox.deviceId) {
    const deviceId = await registerDevice();
    if (deviceId) {
      config.knox.deviceId = deviceId;
      wlog.info('Knox device ID obtained', { deviceId });
    }
  }

  // 2. Encryption key 미설정이면 조회
  if (!config.knox.encryptionKey) {
    const key = await refreshEncryptionKey();
    if (key) {
      wlog.info('Knox encryption key obtained');
    }
  }
}

// ─── 디바이스 등록 ───

export async function registerDevice(): Promise<string | null> {
  try {
    const res = await knoxFetch('/messenger/contact/api/v2.0/device/o1/reg');
    const data = await res.json();
    wlog.info('Knox device registration response', { data });
    const deviceId = data?.deviceId || data?.device_id || data?.deviceServerID;
    if (deviceId) {
      wlog.info('Knox device registered', { deviceId });
      return String(deviceId);
    }
    wlog.error('Knox device registration: no deviceId in response', { data });
    return null;
  } catch (err) {
    wlog.error('Knox device registration failed', { error: String(err) });
    return null;
  }
}

// ─── 암호화 키 조회/갱신 ───

export async function refreshEncryptionKey(): Promise<string | null> {
  try {
    const res = await knoxFetch('/messenger/msgctx/api/v2.0/key/getkeys');
    const data = await res.json();
    const key = data?.key || data?.encryptionKey;
    if (key) {
      config.knox.encryptionKey = String(key);
      wlog.info('Knox encryption key refreshed', { keyLength: String(key).length });
      return String(key);
    }
    wlog.error('Knox getkeys: no key in response', { data });
    return null;
  } catch (err) {
    wlog.error('Knox getkeys failed', { error: String(err) });
    return null;
  }
}

// ─── 대화방 생성 ───

export async function createChatroom(
  receivers: number[],
  chatType: number = 5,
  title?: string,
): Promise<{ chatroomId: number } | null> {
  const body: KnoxCreateChatroomBody = {
    requestId: Date.now(),
    chatType,
    receivers,
    ...(title && { chatroomTitle: title }),
  };

  try {
    const encrypted = encryptPayload(body);
    const res = await knoxFetch('/messenger/message/api/v2.0/message/createChatroomRequest', {
      method: 'POST',
      body: encrypted, // Knox는 암호화된 문자열 자체를 body로 기대
    });
    const raw = await res.text();
    const decrypted = decryptResponse<{ chatroomId: number; result: { code: number } }>(raw);
    if (decrypted && decrypted.result?.code === 1000) {
      wlog.info('Knox chatroom created', { chatroomId: decrypted.chatroomId });
      return { chatroomId: decrypted.chatroomId };
    }
    wlog.error('Knox createChatroom failed', { response: decrypted });
    return null;
  } catch (err) {
    wlog.error('Knox createChatroom error', { error: String(err) });
    return null;
  }
}

// ─── 메시지 발신 ───

export async function sendMessage(chatroomId: number, message: string): Promise<boolean> {
  // 3300자 초과 시 분할 발신
  if (message.length > 3300) {
    return sendLongMessage(chatroomId, message);
  }
  return sendSingleMessage(chatroomId, message);
}

async function sendSingleMessage(chatroomId: number, message: string, retried = false): Promise<boolean> {
  const msgId = Date.now();
  const body: KnoxChatRequestBody = {
    requestId: msgId,
    chatroomId,
    chatMessageParams: [
      {
        msgId,
        msgType: 0,
        chatMsg: message,
        msgTtl: 259200,
      },
    ],
  };

  try {
    const encrypted = encryptPayload(body);
    const res = await knoxFetch('/messenger/message/api/v2.0/message/chatRequest', {
      method: 'POST',
      body: encrypted, // Knox는 암호화된 문자열 자체를 body로 기대
    });
    const raw = await res.text();
    const decrypted = decryptResponse<{ result: { code: number; msg?: string } }>(raw);

    if (decrypted && decrypted.result?.code === 1000) {
      wlog.info('Knox message sent', { chatroomId, msgLength: message.length });
      return true;
    }

    // 에러 4003: 암호화 키 만료 → 키 갱신 후 1회만 재시도
    if (!retried && decrypted && decrypted.result?.code === 4003) {
      wlog.warn('Knox error 4003: refreshing encryption key and retrying');
      const newKey = await refreshEncryptionKey();
      if (newKey) {
        return sendSingleMessage(chatroomId, message, true);
      }
    }

    wlog.error('Knox sendMessage failed', { chatroomId, response: decrypted });
    return false;
  } catch (err) {
    wlog.error('Knox sendMessage error', { chatroomId, error: String(err) });
    return false;
  }
}

// 3300자 초과 메시지 분할 발신
async function sendLongMessage(chatroomId: number, message: string): Promise<boolean> {
  const chunks: string[] = [];
  for (let i = 0; i < message.length; i += 3200) {
    chunks.push(message.slice(i, i + 3200));
  }
  wlog.info('Knox splitting long message', { chatroomId, totalLength: message.length, chunks: chunks.length });

  for (let i = 0; i < chunks.length; i++) {
    const prefix = chunks.length > 1 ? `[${i + 1}/${chunks.length}] ` : '';
    const success = await sendSingleMessage(chatroomId, prefix + chunks[i]);
    if (!success) return false;
    // Rate limit 준수: 50건/초 → chunk 간 100ms 대기
    if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 100));
  }
  return true;
}
