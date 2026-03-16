import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config.js';
import { wlog, requestLogger } from './middleware/logger.js';
import { initRedis } from './services/bot-registry.js';
import { initKnoxApi } from './services/knox-api.js';
import { webhookRouter } from './routes/webhook.js';
import { registerRouter } from './routes/register.js';
import { responseRouter } from './routes/response.js';

const app = express();

// ─── Middleware ───
app.use(helmet());
app.use(cors());
app.use(requestLogger);

// Note: /message (Knox webhook)은 webhook.ts에서 자체 text parser 사용
//       /api/* 경로만 JSON parser 적용
app.use('/api', express.json({ limit: '1mb' }));

// ─── Routes ───
app.use('/', webhookRouter);          // POST /message (Knox webhook, raw text body)
app.use('/api/bots', registerRouter); // Bot registration CRUD
app.use('/api/response', responseRouter); // Bot → Knox response

// ─── Health ───
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ─── Start ───
async function main(): Promise<void> {
  // Redis 연결
  initRedis();

  // Knox API 초기화 (device 등록 + encryption key 조회)
  await initKnoxApi();

  app.listen(config.port, () => {
    wlog.info(`Knox Message Server listening on :${config.port}`);
    wlog.info('Configuration', {
      knoxApiBase: config.knox.apiBaseUrl ? 'set' : 'NOT SET',
      knoxDeviceId: config.knox.deviceId ? 'set' : 'NOT SET',
      knoxEncryptionKey: config.knox.encryptionKey ? 'set' : 'NOT SET',
      botApiKey: config.botApiKey ? 'set' : 'NOT SET',
    });
    if (!config.botApiKey) {
      wlog.warn('⚠️  BOT_API_KEY is not set — bot registration/response API is UNAUTHENTICATED');
    }
  });
}

main().catch((err) => {
  wlog.error('Failed to start server', { error: String(err) });
  process.exit(1);
});
