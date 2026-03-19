/**
 * POST /api/response — Nexus Bot → Knox Messenger 응답 발신
 *
 * Bot이 작업 완료 후 이 엔드포인트를 호출하면
 * Message Server가 Knox chatRequest API로 대화방에 응답을 발신한다.
 */

import { Router } from 'express';
import { sendMessage, sendAdaptiveCard, updateAdaptiveCard } from '../services/knox-api.js';
import { config } from '../config.js';
import { wlog } from '../middleware/logger.js';

export const responseRouter = Router();

// API Key 검증
function verifyApiKey(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction): void {
  const apiKey = req.headers['x-api-key'];
  if (!config.botApiKey || apiKey === config.botApiKey) {
    next();
    return;
  }
  res.status(401).json({ error: 'Unauthorized' });
}

responseRouter.use(verifyApiKey);

responseRouter.post('/', async (req, res) => {
  const { chatroomId, message } = req.body;

  if (!chatroomId || !message) {
    res.status(400).json({ error: 'chatroomId and message are required' });
    return;
  }

  wlog.info('Bot response received', {
    chatroomId,
    message: String(message).slice(0, 500),
  });

  try {
    const success = await sendMessage(Number(chatroomId), String(message));
    if (success) {
      res.json({ success: true });
    } else {
      res.status(502).json({ success: false, error: 'Knox API call failed' });
    }
  } catch (err) {
    wlog.error('Response: Knox send failed', { chatroomId, error: String(err) });
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ─── Adaptive Card 발신 (msgType 19) ───
responseRouter.post('/card', async (req, res) => {
  const { chatroomId, card } = req.body;
  if (!chatroomId || !card) {
    res.status(400).json({ error: 'chatroomId and card (JSON object) are required' });
    return;
  }
  wlog.info('Bot Adaptive Card response', { chatroomId });
  try {
    const result = await sendAdaptiveCard(Number(chatroomId), card);
    if (result) {
      res.json({ success: true, msgId: result.msgId });
    } else {
      res.status(502).json({ success: false, error: 'Knox Adaptive Card send failed' });
    }
  } catch (err) {
    wlog.error('Response: Adaptive Card send failed', { chatroomId, error: String(err) });
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ─── Adaptive Card 업데이트 (msgType 20 — 기존 카드 교체) ───
responseRouter.post('/update-card', async (req, res) => {
  const { chatroomId, originalMsgId, card } = req.body;
  if (!chatroomId || !originalMsgId || !card) {
    res.status(400).json({ error: 'chatroomId, originalMsgId, and card are required' });
    return;
  }
  wlog.info('Bot Adaptive Card update', { chatroomId, originalMsgId });
  try {
    const success = await updateAdaptiveCard(Number(chatroomId), Number(originalMsgId), card);
    if (success) {
      res.json({ success: true });
    } else {
      res.status(502).json({ success: false, error: 'Knox Adaptive Card update failed' });
    }
  } catch (err) {
    wlog.error('Response: Adaptive Card update failed', { chatroomId, error: String(err) });
    res.status(500).json({ success: false, error: String(err) });
  }
});
