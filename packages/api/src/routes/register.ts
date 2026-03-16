/**
 * Bot Registration API
 *
 * POST   /api/bots/register     — Nexus Bot 등록 (knoxUserId + endpoint)
 * DELETE /api/bots/:knoxUserId   — Nexus Bot 해제
 * POST   /api/bots/heartbeat     — TTL 갱신
 * GET    /api/bots               — 등록된 Bot 목록
 */

import { Router } from 'express';
import { registerBot, unregisterBot, listBots, heartbeat } from '../services/bot-registry.js';
import { config } from '../config.js';
import { wlog } from '../middleware/logger.js';

export const registerRouter = Router();

// API Key 검증 미들웨어
function verifyApiKey(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction): void {
  const apiKey = req.headers['x-api-key'];
  if (!config.botApiKey || apiKey === config.botApiKey) {
    next();
    return;
  }
  wlog.warn('Register: invalid API key', { ip: req.ip });
  res.status(401).json({ error: 'Unauthorized' });
}

registerRouter.use(verifyApiKey);

// ─── Bot 등록 ───
registerRouter.post('/register', async (req, res) => {
  const { knoxUserId, endpoint } = req.body;
  if (!knoxUserId || !endpoint) {
    res.status(400).json({ error: 'knoxUserId and endpoint are required' });
    return;
  }

  await registerBot(String(knoxUserId), String(endpoint));
  res.json({ success: true, knoxUserId, endpoint });
});

// ─── Bot 해제 ───
registerRouter.delete('/:knoxUserId', async (req, res) => {
  const found = await unregisterBot(req.params.knoxUserId);
  res.json({ success: true, found });
});

// ─── Heartbeat ───
registerRouter.post('/heartbeat', async (req, res) => {
  const { knoxUserId } = req.body;
  if (!knoxUserId) {
    res.status(400).json({ error: 'knoxUserId is required' });
    return;
  }
  const found = await heartbeat(String(knoxUserId));
  res.json({ success: true, found });
});

// ─── Bot 목록 ───
registerRouter.get('/', async (_req, res) => {
  const bots = await listBots();
  res.json({ bots });
});
