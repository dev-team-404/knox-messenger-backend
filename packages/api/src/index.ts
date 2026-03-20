import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config.js';
import { wlog, requestLogger } from './middleware/logger.js';
import { initRedis, getRedis, listBots } from './services/bot-registry.js';
import { initKnoxApi } from './services/knox-api.js';
import { stats } from './services/stats.js';
import { webhookRouter } from './routes/webhook.js';
import { registerRouter } from './routes/register.js';
import { responseRouter } from './routes/response.js';
import { initiateRouter } from './routes/initiate.js';

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
app.use('/api/initiate', initiateRouter); // Bot → Knox initiate conversation

// ─── Health ───
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ─── SSO 인증 콜백 ───
const dashboardSessions = new Map<string, { loginId: string; expiresAt: number }>(); // token → session

app.get('/dashboard/sso-callback', (req, res) => {
  const data = req.query.data as string;
  if (!data) { res.status(400).send('SSO data missing'); return; }
  try {
    const payload = JSON.parse(data);
    const loginId = payload.loginid;
    if (loginId !== config.sso.adminLoginId) {
      res.status(403).send(`<h1>접근 거부</h1><p>${loginId}은(는) 관리자가 아닙니다.</p>`);
      return;
    }
    // 세션 토큰 발급 (24시간)
    const token = `dash_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    dashboardSessions.set(token, { loginId, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
    res.redirect(`/dashboard?token=${token}`);
  } catch {
    res.status(400).send('SSO data parse failed');
  }
});

// ─── Admin Dashboard (SSO: syngha.han만 접근 가능) ───
app.get('/dashboard', async (req, res) => {
  // SSO 인증 체크
  const token = req.query.token as string;
  const session = token ? dashboardSessions.get(token) : null;
  if (!session || session.expiresAt < Date.now()) {
    if (token) dashboardSessions.delete(token); // 만료된 세션 제거
    const callbackUrl = `http://${req.headers.host}/dashboard/sso-callback`;
    const ssoUrl = `${config.sso.baseUrl}${config.sso.ssoPath}?redirect_url=${encodeURIComponent(callbackUrl)}`;
    res.redirect(ssoUrl);
    return;
  }

  try {
    const bots = await listBots();
    const redis = getRedis();
    const redisInfo = await redis.info('memory').catch(() => '');
    const usedMemory = redisInfo.match(/used_memory_human:(\S+)/)?.[1] || 'N/A';

    const uptime = process.uptime();
    const uptimeStr = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;

    // 24시간 이내 활성 세션만
    const now = Date.now();
    const activeSessions = [...stats.activeSessions.values()]
      .filter(s => now - new Date(s.lastActive).getTime() < 24 * 60 * 60 * 1000);

    const html = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Jarvis Message Server Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #e6edf3; padding: 24px; }
    h1 { font-size: 20px; margin-bottom: 20px; color: #58a6ff; }
    h2 { font-size: 14px; margin: 16px 0 8px; color: #8b949e; text-transform: uppercase; letter-spacing: 1px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 20px; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; }
    .card .label { font-size: 11px; color: #8b949e; margin-bottom: 4px; }
    .card .value { font-size: 24px; font-weight: 600; }
    .card .value.green { color: #3fb950; }
    .card .value.red { color: #f85149; }
    .card .value.blue { color: #58a6ff; }
    .card .value.yellow { color: #d29922; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
    th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #21262d; font-size: 13px; }
    th { color: #8b949e; font-weight: 500; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 500; }
    .badge.online { background: rgba(63, 185, 80, 0.15); color: #3fb950; }
    .badge.error { background: rgba(248, 81, 73, 0.15); color: #f85149; }
    .refresh { color: #58a6ff; text-decoration: none; font-size: 12px; float: right; }
    .error-log { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px; max-height: 300px; overflow-y: auto; font-family: monospace; font-size: 11px; line-height: 1.6; }
    .error-log .entry { border-bottom: 1px solid #21262d; padding: 4px 0; }
    .error-log .time { color: #8b949e; }
    .error-log .path { color: #d29922; }
    .error-log .msg { color: #f85149; }
  </style>
</head>
<body>
  <h1>Jarvis Message Server <a href="/dashboard?token=${token}" class="refresh">새로고침</a></h1>

  <h2>서버 상태</h2>
  <div class="grid">
    <div class="card"><div class="label">상태</div><div class="value green">Running</div></div>
    <div class="card"><div class="label">가동 시간</div><div class="value blue">${uptimeStr}</div></div>
    <div class="card"><div class="label">Redis 메모리</div><div class="value">${usedMemory}</div></div>
    <div class="card"><div class="label">등록된 봇</div><div class="value blue">${bots.length}</div></div>
  </div>

  <h2>메시지 통계</h2>
  <div class="grid">
    <div class="card"><div class="label">웹훅 수신</div><div class="value">${stats.webhooksReceived}</div></div>
    <div class="card"><div class="label">봇 전달 성공</div><div class="value green">${stats.webhooksForwarded}</div></div>
    <div class="card"><div class="label">봇 전달 실패</div><div class="value red">${stats.webhooksFailed}</div></div>
    <div class="card"><div class="label">Knox 발신 성공</div><div class="value green">${stats.messagesSent}</div></div>
    <div class="card"><div class="label">Knox 발신 실패</div><div class="value red">${stats.messagesFailed}</div></div>
  </div>

  <h2>등록된 봇 (${bots.length})</h2>
  <table>
    <tr><th>Knox ID</th><th>Endpoint</th><th>등록</th><th>마지막 활동</th><th>상태</th></tr>
    ${bots.map(b => {
      const lastSeen = new Date(b.lastSeen);
      const isRecent = now - lastSeen.getTime() < 10 * 60 * 1000; // 10분 이내
      return `<tr>
        <td>${b.knoxUserId}</td>
        <td>${b.endpoint}</td>
        <td>${new Date(b.registeredAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</td>
        <td>${lastSeen.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</td>
        <td><span class="badge ${isRecent ? 'online' : 'error'}">${isRecent ? 'Online' : 'Offline'}</span></td>
      </tr>`;
    }).join('')}
  </table>

  <h2>활성 세션 (24시간, ${activeSessions.length}명)</h2>
  <table>
    <tr><th>Knox ID</th><th>마지막 메시지</th><th>메시지 수</th></tr>
    ${activeSessions.map(s => `<tr>
      <td>${s.loginId}</td>
      <td>${new Date(s.lastActive).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</td>
      <td>${s.messageCount}</td>
    </tr>`).join('') || '<tr><td colspan="3" style="color:#8b949e">활성 세션 없음</td></tr>'}
  </table>

  <h2>최근 에러 (${stats.errors.length}건)</h2>
  <div class="error-log">
    ${stats.errors.slice(-20).reverse().map(e =>
      `<div class="entry"><span class="time">${e.time}</span> <span class="path">${e.path}</span> <span class="msg">${e.error}</span></div>`
    ).join('') || '<div style="color:#8b949e">에러 없음</div>'}
  </div>

  <script>setTimeout(() => location.href='/dashboard?token=${token}', 30000);</script>
</body>
</html>`;

    res.type('html').send(html);
  } catch (err) {
    res.status(500).send(`Dashboard error: ${err}`);
  }
});

// ─── Start ───
async function main(): Promise<void> {
  // Redis 연결
  initRedis();

  // Knox API 초기화 (device 등록 + encryption key 조회)
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

  // Keep-Alive 설정 (nginx와 동기화)
  server.keepAliveTimeout = 75000;
  server.headersTimeout = 76000;

  // Graceful shutdown
  const shutdown = () => {
    wlog.info('Shutting down gracefully...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000); // 10초 후 강제 종료
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  wlog.error('Failed to start server', { error: String(err) });
  process.exit(1);
});
