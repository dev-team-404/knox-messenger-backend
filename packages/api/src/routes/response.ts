/**
 * POST /api/response — Nexus Bot → Knox Messenger 응답 발신
 *
 * Bot이 작업 완료 후 이 엔드포인트를 호출하면
 * Message Server가 Knox chatRequest API로 대화방에 응답을 발신한다.
 */

import { Router } from 'express';
import { sendMessage } from '../services/knox-api.js';
import { config } from '../config.js';
import { wlog } from '../middleware/logger.js';
import { stats, recordError } from '../services/stats.js';

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
    const success = await sendMessage(String(chatroomId), String(message));
    if (success) {
      stats.messagesSent++;
      res.json({ success: true });
    } else {
      stats.messagesFailed++;
      recordError('/api/response', 'Knox API returned failure', {
        errorType: 'knox_api_error',
        chatroomId: String(chatroomId),
      });
      res.status(502).json({ success: false, error: 'Knox API call failed' });
    }
  } catch (err) {
    stats.messagesFailed++;
    recordError('/api/response', String(err), {
      chatroomId: String(chatroomId),
    });
    wlog.error('Response: Knox send failed', { chatroomId, error: String(err) });
    res.status(500).json({ success: false, error: String(err) });
  }
});

