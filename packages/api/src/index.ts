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
import { initiateRouter } from './routes/initiate.js';
import { dashboardRouter } from './routes/dashboard.js';

const app = express();

// ─── Middleware ───
app.use(helmet({ contentSecurityPolicy: false })); // dashboard inline script 허용
app.use(cors());
app.use(requestLogger);

// /message는 webhook.ts에서 자체 text parser, /api/*는 JSON parser
app.use('/api', express.json({ limit: '1mb' }));
app.use('/dashboard/api', express.json({ limit: '1mb' }));

// ─── Routes ───
app.use('/', webhookRouter);
app.use('/api/bots', registerRouter);
app.use('/api/response', responseRouter);
app.use('/api/initiate', initiateRouter);
app.use('/dashboard', dashboardRouter);

// ─── Health ───
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ─── Start ───
async function main(): Promise<void> {
  initRedis();
  await initKnoxApi();

  const server = app.listen(config.port, () => {
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

  server.keepAliveTimeout = 75000;
  server.headersTimeout = 76000;

  const shutdown = () => {
    wlog.info('Shutting down gracefully...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  wlog.error('Failed to start server', { error: String(err) });
  process.exit(1);
});
