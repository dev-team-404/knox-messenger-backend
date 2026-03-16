/**
 * POST /message — Knox Messenger 웹훅 수신
 *
 * Knox에서 챗봇 계정으로 메시지가 들어오면 이 엔드포인트를 호출한다.
 * 1. 수신 payload 복호화 (또는 평문 JSON 파싱)
 * 2. senderId로 등록된 Nexus Bot 조회
 * 3. Bot에게 메시지 전달 (비동기 fire-and-forget)
 * 4. Knox에 200 응답
 *
 * Note: Express의 전역 json() 파서를 거치지 않기 위해
 *       이 라우터는 raw text body 파서를 사용한다.
 */

import { Router, text as expressText } from 'express';
import { decryptPayload } from '../services/knox-crypto.js';
import { getBot } from '../services/bot-registry.js';
import { wlog } from '../middleware/logger.js';
import { config } from '../config.js';
import type { KnoxWebhookPayload, BotTaskRequest } from '../types.js';

export const webhookRouter = Router();

// Knox webhook은 암호화된 raw string으로 올 수 있으므로
// 모든 Content-Type을 text로 수신
webhookRouter.post(
  '/message',
  expressText({ type: '*/*', limit: '1mb' }),
  async (req, res) => {
    try {
      const rawBody = typeof req.body === 'string' ? req.body.trim() : '';
      if (!rawBody) {
        wlog.warn('Webhook: empty body');
        res.sendStatus(200); // Knox에 항상 200 (재시도 방지)
        return;
      }

      // 1차: 복호화 시도 (암호화된 payload)
      let payload = decryptPayload<KnoxWebhookPayload>(stripJsonQuotes(rawBody));

      // 2차: 복호화 실패 시 평문 JSON 시도 (일부 Knox 환경에서 평문 전송)
      if (!payload) {
        try {
          payload = JSON.parse(rawBody) as KnoxWebhookPayload;
        } catch {
          wlog.error('Webhook: decryption and JSON parse both failed');
          res.sendStatus(200);
          return;
        }
      }

      const { senderId, chatroomId, chatMsg, msgId, senderName } = payload;
      if (!senderId || !chatMsg) {
        wlog.warn('Webhook: missing senderId or chatMsg', { senderId, hasChatMsg: !!chatMsg });
        res.sendStatus(200);
        return;
      }

      wlog.info('Webhook received', {
        senderId,
        chatroomId,
        msgLength: chatMsg.length,
        msgId,
      });

      // senderId로 등록된 Bot 조회
      const bot = await getBot(String(senderId));
      if (!bot) {
        wlog.warn('Webhook: no bot registered for sender', { senderId });
        res.sendStatus(200);
        return;
      }

      // Bot에게 메시지 전달 (비동기 — Knox 응답을 차단하지 않음)
      const taskRequest: BotTaskRequest = {
        chatroomId: String(chatroomId),
        senderId: String(senderId),
        senderName: senderName || '',
        message: chatMsg,
        messageId: String(msgId),
      };

      forwardToBot(bot.endpoint, taskRequest).catch((err) => {
        wlog.error('Webhook: failed to forward to bot', {
          endpoint: bot.endpoint,
          error: String(err),
        });
      });

      res.sendStatus(200);
    } catch (err) {
      wlog.error('Webhook: unhandled error', { error: String(err) });
      res.sendStatus(200);
    }
  },
);

/**
 * Knox 응답이 JSON string으로 올 수 있음 (따옴표 래핑)
 * "base64string" → base64string
 */
function stripJsonQuotes(text: string): string {
  if (text.startsWith('"') && text.endsWith('"')) {
    try { return JSON.parse(text) as string; } catch { /* 그대로 */ }
  }
  return text;
}

async function forwardToBot(endpoint: string, task: BotTaskRequest): Promise<void> {
  const url = `${endpoint}/jarvis/message`;
  wlog.info('Forwarding to bot', { url, chatroomId: task.chatroomId });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': config.botApiKey,
    },
    body: JSON.stringify(task),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`Bot returned ${res.status}: ${await res.text().catch(() => '')}`);
  }
  wlog.info('Forwarded to bot successfully', { endpoint });
}
