/**
 * POST /message — Knox Messenger 웹훅 수신
 *
 * Knox 수신 API 스펙:
 * - Content-Type: text/plain
 * - Headers: botUserEmail, botNotiType
 * - Body: AES256 암호화 + Base64 인코딩된 JSON
 * - 복호화 후 필드: sender, sentTime, senderName, chatType, chatroomId,
 *                   msgId, msgType, chatMsg, senderKnoxId
 */

import { Router, text as expressText } from 'express';
import { decryptPayload } from '../services/knox-crypto.js';
import { getBot } from '../services/bot-registry.js';
import { sendMessage, sendAdaptiveCard } from '../services/knox-api.js';
import { wlog } from '../middleware/logger.js';
import { config } from '../config.js';
import { stats, recordError, trackSession } from '../services/stats.js';
import type { KnoxWebhookPayload, BotTaskRequest } from '../types.js';

export const webhookRouter = Router();

webhookRouter.post(
  '/message',
  expressText({ type: '*/*', limit: '1mb' }),
  async (req, res) => {
    try {
      const rawBody = typeof req.body === 'string' ? req.body.trim() : '';

      // Knox webhook 헤더 + raw body 전체 로깅
      const botNotiType = req.headers['botnotitype'] as string || '';
      const botUserEmail = req.headers['botuseremail'] as string || '';
      wlog.info('Webhook RAW INPUT', {
        contentType: req.headers['content-type'],
        botUserEmail,
        botNotiType,
        rawBodyLength: rawBody.length,
        rawBody: rawBody.slice(0, 2000),
      });

      if (!rawBody) {
        wlog.warn('Webhook: empty body');
        res.sendStatus(200);
        return;
      }

      // 1차: 복호화 시도 (AES256 + Base64)
      let payload = decryptPayload<KnoxWebhookPayload>(stripJsonQuotes(rawBody));

      // 2차: 복호화 실패 시 평문 JSON 시도
      if (!payload) {
        try {
          payload = JSON.parse(rawBody) as KnoxWebhookPayload;
        } catch {
          wlog.error('Webhook: decryption and JSON parse both failed');
          res.sendStatus(200);
          return;
        }
      }

      // 파싱된 payload 전체 로깅
      wlog.info('Webhook PARSED PAYLOAD', {
        fields: Object.keys(payload),
        payload: JSON.stringify(payload).slice(0, 2000),
      });

      const { sender, chatroomId, chatMsg, msgId, senderName, senderKnoxId, chatType, msgType } = payload;
      if (!sender || !chatMsg) {
        wlog.warn('Webhook: missing sender or chatMsg', { sender, hasChatMsg: !!chatMsg });
        res.sendStatus(200);
        return;
      }

      stats.webhooksReceived++;
      if (senderKnoxId) trackSession(senderKnoxId);

      wlog.info('Webhook received', {
        sender,
        senderName: senderName || '(unknown)',
        senderKnoxId: senderKnoxId || '',
        chatroomId,
        msgId,
        chatType,
        msgType,
        chatMsg: chatMsg.slice(0, 500),
        isIntro: botNotiType === 'INTRO',
      });

      // senderKnoxId(SSO loginid)로 먼저 조회, 없으면 sender(Knox numeric ID)로 fallback
      let bot = senderKnoxId ? await getBot(senderKnoxId) : null;
      if (!bot) {
        bot = await getBot(String(sender));
      }
      if (!bot) {
        wlog.warn('Webhook: no bot registered for sender', { sender, senderKnoxId });
        res.sendStatus(200);
        return;
      }

      // Knox chatMsg에서 HTML 메타데이터 주석 제거
      const cleanMsg = chatMsg.replace(/<!--[\s\S]*?-->/g, '').trim();

      // 즉시 "생각 중..." Adaptive Card 전송 (Electron 응답 기다리지 않음)
      if (!botNotiType || botNotiType !== 'INTRO') {
        sendAdaptiveCard(String(chatroomId), {
          '$schema': 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.0',
          body: [
            { type: 'TextBlock', text: '🤔 생각 중...', weight: 'bolder', size: 'medium' },
            { type: 'TextBlock', text: cleanMsg.slice(0, 100), wrap: true, isSubtle: true, size: 'small' },
          ],
        }).catch((err) => {
          // Adaptive Card 실패 시 plain text fallback
          wlog.warn('Webhook: thinking card failed, trying text', { error: String(err) });
          sendMessage(String(chatroomId), '🤔 생각 중...').catch(() => {});
        });
      }

      // Bot에게 메시지 전달
      const taskRequest: BotTaskRequest = {
        chatroomId: String(chatroomId),
        senderId: String(sender),
        senderName: senderName || '',
        senderKnoxId: senderKnoxId || '',
        message: cleanMsg || chatMsg, // 클린 실패 시 원본 사용
        messageId: String(msgId),
        chatType: chatType || 'SINGLE',
        msgType: msgType || 'TEXT',
        isIntro: botNotiType === 'INTRO',
      };

      forwardToBot(bot.endpoint, taskRequest).then(() => {
        stats.webhooksForwarded++;
      }).catch((err) => {
        stats.webhooksFailed++;
        recordError('/message→bot', String(err));
        wlog.error('Webhook: failed to forward to bot', {
          endpoint: bot.endpoint,
          error: String(err),
        });
      });

      res.sendStatus(200);
    } catch (err) {
      recordError('/message', String(err));
      wlog.error('Webhook: unhandled error', { error: String(err) });
      res.sendStatus(200);
    }
  },
);

function stripJsonQuotes(text: string): string {
  if (text.startsWith('"') && text.endsWith('"')) {
    try { return JSON.parse(text) as string; } catch { /* 그대로 */ }
  }
  return text;
}

async function forwardToBot(endpoint: string, task: BotTaskRequest): Promise<void> {
  const url = `${endpoint}/jarvis/message`;
  wlog.info('Forwarding to bot', { url, chatroomId: task.chatroomId, senderId: task.senderId });

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
