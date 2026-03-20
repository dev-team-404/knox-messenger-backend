/**
 * Knox Messenger API Client
 *
 * - 디바이스 등록 (GET /messenger/contact/api/v2.0/device/o1/reg)
 * - 암호화 키 조회 (GET /messenger/msgctx/api/v2.0/key/getkeys)
 * - 대화방 생성 (POST /messenger/message/api/v2.0/message/createChatroomRequest)
 * - 메시지 발신 (POST /messenger/message/api/v2.0/message/chatRequest)
 */

import { config } from '../config.js';
import { encrypt, decrypt, encryptPayload, decryptPayload } from './knox-crypto.js';
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
  wlog.info('═══ Knox API 초기화 시작 ═══');

  // Step 1: Access Token + System-ID 확인
  if (!config.knox.apiBaseUrl || !config.knox.accessToken) {
    wlog.error('Step 1/3 ✗ Access Token 또는 API Base URL 미설정 — 초기화 중단');
    return;
  }
  wlog.info('Step 1/3 ✓ Access Token + System-ID 확인 완료', {
    apiBaseUrl: config.knox.apiBaseUrl,
    systemId: config.knox.systemId,
    accessToken: config.knox.accessToken ? `${config.knox.accessToken.slice(0, 8)}...` : 'NOT SET',
  });

  // Step 2: Device 등록 → Device ID 획득
  if (!config.knox.deviceId) {
    wlog.info('Step 2/3 디바이스 등록 중...');
    const deviceId = await registerDevice();
    if (deviceId) {
      config.knox.deviceId = deviceId;
      wlog.info('Step 2/3 ✓ Device ID 획득 완료', { deviceId });
    } else {
      wlog.error('Step 2/3 ✗ Device ID 획득 실패 — 이후 API 호출 불가');
      return;
    }
  } else {
    wlog.info('Step 2/3 ✓ Device ID 이미 설정됨', { deviceId: config.knox.deviceId });
  }

  // Step 3: 암호화 키 조회
  if (!config.knox.encryptionKey) {
    wlog.info('Step 3/3 암호화 키 조회 중...');
    const key = await refreshEncryptionKey();
    if (key) {
      wlog.info('Step 3/3 ✓ Encryption Key 획득 완료', { keyLength: key.length });
    } else {
      wlog.error('Step 3/3 ✗ Encryption Key 획득 실패 — 메시지 암복호화 불가');
      return;
    }
  } else {
    wlog.info('Step 3/3 ✓ Encryption Key 이미 설정됨', { keyLength: config.knox.encryptionKey.length });
  }

  wlog.info('═══ Knox API 초기화 완료 — 대화방 생성/메시지 발신 준비 완료 ═══');
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

// ─── Login ID → Knox 숫자 User ID 검색 ───

export async function searchUserByLoginId(loginId: string): Promise<string | null> {
  try {
    const res = await knoxFetch('/messenger/contact/api/v2.0/profile/o1/search/loginid', {
      method: 'POST',
      body: JSON.stringify({
        singleIdList: [{ singleId: loginId }],
      }),
    });
    // ⚠️ JSON.parse()로 파싱하면 int64 ID가 정밀도를 잃음 (845030079967268900 → 845030079967268864)
    // raw text에서 regex로 정확한 숫자 문자열을 추출
    const raw = await res.text();
    const match = raw.match(new RegExp(`"userID"\\s*:\\s*(\\d+)[^"]*"singleID"\\s*:\\s*"${loginId.replace('.', '\\.')}"`, 'i'))
      || raw.match(/"userID"\s*:\s*(\d+)/);
    if (match?.[1]) {
      wlog.info('Knox user ID found', { loginId, userID: match[1] });
      return match[1]; // 문자열로 반환 (정밀도 보존)
    }
    wlog.warn('Knox user ID not found for loginId', { loginId, raw: raw.slice(0, 500) });
    return null;
  } catch (err) {
    wlog.error('Knox searchUserByLoginId failed', { loginId, error: String(err) });
    return null;
  }
}

// ─── 대화방 생성 ───

export async function createChatroom(
  receivers: (number | string)[],
  chatType: number = 5,
  title?: string,
  retried = false,
): Promise<{ chatroomId: string } | null> {
  // ⚠️ Knox user ID는 int64 → JavaScript Number로 표현하면 정밀도 손실
  // JSON을 직접 조립해서 문자열 ID를 숫자 그대로 보존
  const requestId = Date.now();
  const receiversJson = receivers.map(r => String(r)).join(',');
  const titlePart = title ? `,"chatroomTitle":"${title}"` : '';
  const plainJson = `{"requestId":${requestId},"chatType":${chatType},"receivers":[${receiversJson}]${titlePart}}`;

  try {
    const encrypted = encrypt(plainJson);
    const res = await knoxFetch('/messenger/message/api/v2.0/message/createChatroomRequest', {
      method: 'POST',
      body: encrypted,
    });
    const raw = await res.text();
    wlog.info('Knox createChatroom raw response', { status: res.status, rawLength: raw.length, raw: raw.slice(0, 500) });

    // 비정상 응답: 먼저 plain JSON으로 읽기 (Knox 에러 응답은 암호화 안 됨)
    if (!res.ok) {
      let errorInfo: unknown = null;
      try { errorInfo = JSON.parse(raw); } catch { errorInfo = raw.slice(0, 300); }
      wlog.error('Knox createChatroom error response', { status: res.status, error: errorInfo });

      // 키 만료(4003) 또는 복호화 실패 → 키 갱신 후 1회 재시도
      const errorCode = (errorInfo as any)?.code || (errorInfo as any)?.result?.code;
      if (!retried && (errorCode === 4003 || errorCode === 2001)) {
        wlog.warn('Knox createChatroom: refreshing encryption key and retrying');
        const newKey = await refreshEncryptionKey();
        if (newKey) return createChatroom(receivers, chatType, title, true);
      }
      return null;
    }

    // chatroomId는 int64 → JSON.parse로 파싱하면 정밀도 손실
    // 복호화된 plain text에서 regex로 정확한 숫자 문자열 추출
    let stripped = raw.trim();
    if (stripped.startsWith('"') && stripped.endsWith('"')) {
      try { stripped = JSON.parse(stripped) as string; } catch { /* 그대로 */ }
    }
    const plainText = (() => { try { return decrypt(stripped); } catch { return null; } })();
    if (plainText) {
      wlog.info('Knox createChatroom decrypted', { plainText: plainText.slice(0, 300) });
      const codeMatch = plainText.match(/"code"\s*:\s*(\d+)/);
      const code = codeMatch ? Number(codeMatch[1]) : 0;
      if (code === 1000) {
        const chatroomMatch = plainText.match(/"chatroomId"\s*:\s*(\d+)/);
        const chatroomId = chatroomMatch?.[1] || '0';
        wlog.info('Knox chatroom created', { chatroomId });
        return { chatroomId };
      }
      wlog.error('Knox createChatroom failed', { code, plainText: plainText.slice(0, 300) });
    } else {
      wlog.error('Knox createChatroom: failed to decrypt response');
    }

    return null;
  } catch (err) {
    wlog.error('Knox createChatroom error', { error: String(err) });
    return null;
  }
}

// ─── 메시지 발신 ───

export async function sendMessage(chatroomId: number | string, message: string): Promise<boolean> {
  // 3300자 초과 시 분할 발신
  if (message.length > 3300) {
    return sendLongMessage(chatroomId, message);
  }
  return sendSingleMessage(chatroomId, message);
}

async function sendSingleMessage(chatroomId: number | string, message: string, retried = false): Promise<boolean> {
  const msgId = Date.now();
  // ⚠️ chatroomId는 int64 → JSON 직접 조립으로 정밀도 보존
  const escapedMsg = JSON.stringify(message); // 문자열 이스케이프만 활용
  const plainJson = `{"requestId":${msgId},"chatroomId":${chatroomId},"chatMessageParams":[{"msgId":${msgId},"msgType":0,"chatMsg":${escapedMsg},"msgTtl":259200}]}`;

  try {
    const encrypted = encrypt(plainJson);
    const res = await knoxFetch('/messenger/message/api/v2.0/message/chatRequest', {
      method: 'POST',
      body: encrypted, // Knox는 암호화된 문자열 자체를 body로 기대
    });
    const raw = await res.text();

    // 에러 응답은 암호화 안 됨 → plain JSON으로 먼저 시도
    if (!res.ok) {
      let errorInfo: unknown = null;
      try { errorInfo = JSON.parse(raw); } catch { errorInfo = raw.slice(0, 300); }
      wlog.error('Knox sendMessage error response', { status: res.status, chatroomId, error: errorInfo });
      const errorCode = (errorInfo as any)?.code || (errorInfo as any)?.result?.code;
      if (!retried && (errorCode === 4003 || errorCode === 2001)) {
        wlog.warn('Knox sendMessage: refreshing encryption key and retrying');
        const newKey = await refreshEncryptionKey();
        if (newKey) return sendSingleMessage(chatroomId, message, true);
      }
      return false;
    }

    const decrypted = decryptResponse<{ result: { code: number; msg?: string } }>(raw);
    if (decrypted && decrypted.result?.code === 1000) {
      wlog.info('Knox message sent', { chatroomId, msgLength: message.length });
      return true;
    }

    wlog.error('Knox sendMessage failed', { chatroomId, response: decrypted });
    return false;
  } catch (err) {
    wlog.error('Knox sendMessage error', { chatroomId, error: String(err) });
    return false;
  }
}


// 3300자 초과 메시지 분할 발신
async function sendLongMessage(chatroomId: number | string, message: string): Promise<boolean> {
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
