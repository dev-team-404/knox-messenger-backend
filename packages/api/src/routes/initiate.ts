/**
 * POST /api/initiate — Bot이 사용자에게 먼저 대화 시작
 *
 * 1. Knox createChatroomRequest로 대화방 생성
 * 2. Knox chatRequest로 첫 메시지 발신
 * 3. chatroomId 반환
 */
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { createChatroom, sendMessage } from '../services/knox-api.js';
import { config } from '../config.js';
import { wlog } from '../middleware/logger.js';

export const initiateRouter = Router();

// API Key verification
function verifyApiKey(req: Request, res: Response, next: NextFunction): void {
  const apiKey = req.headers['x-api-key'];
  if (!config.botApiKey || apiKey === config.botApiKey) { next(); return; }
  res.status(401).json({ error: 'Unauthorized' });
}

initiateRouter.use(verifyApiKey);

initiateRouter.post('/', async (req: Request, res: Response) => {
  const { receiverId, message } = req.body;
  if (!receiverId || !message) {
    res.status(400).json({ error: 'receiverId and message are required' });
    return;
  }

  wlog.info('Initiate conversation', { receiverId, msgLength: message.length });

  try {
    // 1. Create chatroom (BROADCAST SINGLE = 1:1 공지방, chatType 5)
    const result = await createChatroom([Number(receiverId)], 5);
    if (!result) {
      res.status(502).json({ success: false, error: 'Failed to create chatroom' });
      return;
    }

    // 2. Send first message
    const sent = await sendMessage(result.chatroomId, message);
    if (!sent) {
      res.status(502).json({ success: false, error: 'Chatroom created but message send failed', chatroomId: String(result.chatroomId) });
      return;
    }

    wlog.info('Conversation initiated', { chatroomId: result.chatroomId, receiverId });
    res.json({ success: true, chatroomId: String(result.chatroomId) });
  } catch (err) {
    wlog.error('Initiate failed', { error: String(err) });
    res.status(500).json({ success: false, error: String(err) });
  }
});
