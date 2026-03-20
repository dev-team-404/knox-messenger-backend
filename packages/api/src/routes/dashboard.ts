/**
 * Admin Dashboard — 실시간 모니터링 + 메시지 전송
 *
 * GET  /dashboard              — SSO 인증 후 대시보드 UI
 * GET  /dashboard/sso-callback — SSO 콜백
 * GET  /dashboard/api/stats    — 실시간 통계 JSON
 * POST /dashboard/api/send     — 특정 임직원에게 메시지 전송
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { config } from '../config.js';
import { listBots } from '../services/bot-registry.js';
import { getRedis } from '../services/bot-registry.js';
import { sendMessage, searchUserByLoginId, createChatroom } from '../services/knox-api.js';
import { stats } from '../services/stats.js';
import { wlog } from '../middleware/logger.js';

export const dashboardRouter = Router();

// ─── SSO 세션 관리 ───
const sessions = new Map<string, { loginId: string; expiresAt: number }>();

dashboardRouter.get('/sso-callback', (req: Request, res: Response) => {
  const data = req.query.data as string;
  if (!data) { res.status(400).send('SSO data missing'); return; }
  try {
    const payload = JSON.parse(data);
    const loginId = payload.loginid;
    if (loginId !== config.sso.adminLoginId) {
      res.status(403).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{background:#0a0a0f;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui}div{text-align:center}h1{color:#f43f5e;font-size:2rem}p{color:#94a3b8;margin-top:8px}</style></head><body><div><h1>Access Denied</h1><p>${loginId} is not an administrator.</p></div></body></html>`);
      return;
    }
    const token = `dash_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    sessions.set(token, { loginId, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
    res.redirect(`/dashboard?token=${token}`);
  } catch {
    res.status(400).send('SSO data parse failed');
  }
});

// ─── 인증 미들웨어 ───
function requireAuth(req: Request, res: Response): string | null {
  const token = (req.query.token as string) || (req.headers.authorization?.replace('Bearer ', '') || '');
  const session = token ? sessions.get(token) : null;
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  return token;
}

// ─── 실시간 통계 API ───
dashboardRouter.get('/api/stats', async (req: Request, res: Response) => {
  const token = requireAuth(req, res);
  if (!token) { res.status(401).json({ error: 'Unauthorized' }); return; }

  try {
    const bots = await listBots();
    const redis = getRedis();
    const redisInfo = await redis.info('memory').catch(() => '');
    const usedMemory = redisInfo.match(/used_memory_human:(\S+)/)?.[1] || 'N/A';
    const connectedClients = redisInfo.match(/connected_clients:(\d+)/)?.[1] || '0';

    const now = Date.now();
    const activeSessions = [...stats.activeSessions.values()]
      .filter(s => now - new Date(s.lastActive).getTime() < 24 * 60 * 60 * 1000)
      .sort((a, b) => new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime());

    const botsWithStatus = bots.map(b => ({
      ...b,
      online: now - new Date(b.lastSeen).getTime() < 10 * 60 * 1000,
    }));

    res.json({
      server: {
        uptime: process.uptime(),
        redisMemory: usedMemory,
        redisClients: Number(connectedClients),
        botsRegistered: bots.length,
        botsOnline: botsWithStatus.filter(b => b.online).length,
      },
      messages: {
        webhooksReceived: stats.webhooksReceived,
        webhooksForwarded: stats.webhooksForwarded,
        webhooksFailed: stats.webhooksFailed,
        messagesSent: stats.messagesSent,
        messagesFailed: stats.messagesFailed,
      },
      bots: botsWithStatus,
      sessions: activeSessions,
      errors: stats.errors.slice(-30).reverse(),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── 메시지 전송 API ───
dashboardRouter.post('/api/send', async (req: Request, res: Response) => {
  const token = requireAuth(req, res);
  if (!token) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const { targetLoginId, message } = req.body;
  if (!targetLoginId || !message) {
    res.status(400).json({ error: 'targetLoginId and message required' });
    return;
  }

  try {
    // 1. loginId → Knox 숫자 ID
    const knoxUserId = await searchUserByLoginId(targetLoginId);
    if (!knoxUserId) {
      res.status(404).json({ error: `User not found: ${targetLoginId}` });
      return;
    }

    // 2. 대화방 생성 (또는 기존)
    const chatroom = await createChatroom([knoxUserId], 0);
    if (!chatroom) {
      res.status(502).json({ error: 'Failed to create chatroom' });
      return;
    }

    // 3. 메시지 전송
    const sent = await sendMessage(chatroom.chatroomId, message);
    if (!sent) {
      res.status(502).json({ error: 'Failed to send message' });
      return;
    }

    wlog.info('Dashboard: message sent', { target: targetLoginId, chatroomId: chatroom.chatroomId });
    res.json({ success: true, chatroomId: chatroom.chatroomId });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── 대시보드 UI ───
dashboardRouter.get('/', async (req: Request, res: Response) => {
  const token = requireAuth(req, res);
  if (!token) {
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
    const port = req.headers['x-forwarded-port'] || '';
    const hostWithPort = String(host).includes(':') ? host : (port ? `${host}:${port}` : `${host}:6080`);
    const callbackUrl = `http://${hostWithPort}/dashboard/sso-callback`;
    const ssoUrl = `${config.sso.baseUrl}${config.sso.ssoPath}?redirect_url=${encodeURIComponent(callbackUrl)}`;
    res.redirect(ssoUrl);
    return;
  }

  res.type('html').send(getDashboardHTML(token));
});

function getDashboardHTML(token: string): string {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jarvis Control Center</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');

  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

  :root {
    --bg-primary: #06080d;
    --bg-secondary: #0d1117;
    --bg-card: #161b22;
    --bg-card-hover: #1c2129;
    --bg-input: #0d1117;
    --border: #21262d;
    --border-hover: #30363d;
    --text-primary: #f0f6fc;
    --text-secondary: #8b949e;
    --text-tertiary: #484f58;
    --accent-blue: #58a6ff;
    --accent-green: #3fb950;
    --accent-red: #f85149;
    --accent-yellow: #d29922;
    --accent-purple: #bc8cff;
    --accent-cyan: #39d2c0;
    --glow-blue: rgba(88, 166, 255, 0.15);
    --glow-green: rgba(63, 185, 80, 0.15);
    --glow-red: rgba(248, 81, 73, 0.15);
    --radius: 12px;
    --radius-lg: 16px;
    --shadow: 0 2px 8px rgba(0,0,0,0.3), 0 0 1px rgba(0,0,0,0.5);
  }

  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    background: var(--bg-primary);
    color: var(--text-primary);
    line-height: 1.5;
    min-height: 100vh;
  }

  /* ─── Header ─── */
  .header {
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border);
    padding: 16px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    position: sticky;
    top: 0;
    z-index: 10;
    backdrop-filter: blur(12px);
  }
  .header-left { display: flex; align-items: center; gap: 12px; }
  .header-logo {
    width: 32px; height: 32px; border-radius: 8px;
    background: linear-gradient(135deg, var(--accent-blue), var(--accent-purple));
    display: flex; align-items: center; justify-content: center;
    font-weight: 700; font-size: 14px; color: white;
  }
  .header-title { font-size: 16px; font-weight: 600; }
  .header-subtitle { font-size: 11px; color: var(--text-secondary); }
  .live-badge {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 4px 10px; border-radius: 20px;
    background: var(--glow-green); color: var(--accent-green);
    font-size: 11px; font-weight: 500;
  }
  .live-dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--accent-green);
    animation: pulse-dot 2s infinite;
  }
  @keyframes pulse-dot {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.5; transform: scale(1.5); }
  }

  /* ─── Main Layout ─── */
  .main { max-width: 1400px; margin: 0 auto; padding: 24px; }

  /* ─── Stats Grid ─── */
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
    margin-bottom: 24px;
  }
  .stat-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 20px;
    transition: all 0.2s;
    position: relative;
    overflow: hidden;
  }
  .stat-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 3px;
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  }
  .stat-card.blue::before { background: var(--accent-blue); }
  .stat-card.green::before { background: var(--accent-green); }
  .stat-card.red::before { background: var(--accent-red); }
  .stat-card.yellow::before { background: var(--accent-yellow); }
  .stat-card.purple::before { background: var(--accent-purple); }
  .stat-card.cyan::before { background: var(--accent-cyan); }
  .stat-card:hover { border-color: var(--border-hover); transform: translateY(-2px); box-shadow: var(--shadow); }
  .stat-label { font-size: 11px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px; font-weight: 500; }
  .stat-value { font-size: 28px; font-weight: 700; margin-top: 4px; font-variant-numeric: tabular-nums; }
  .stat-value.blue { color: var(--accent-blue); }
  .stat-value.green { color: var(--accent-green); }
  .stat-value.red { color: var(--accent-red); }
  .stat-value.yellow { color: var(--accent-yellow); }
  .stat-value.purple { color: var(--accent-purple); }
  .stat-value.cyan { color: var(--accent-cyan); }
  .stat-change { font-size: 11px; color: var(--text-tertiary); margin-top: 4px; }

  /* ─── Sections ─── */
  .sections-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
    margin-bottom: 24px;
  }
  @media (max-width: 900px) { .sections-grid { grid-template-columns: 1fr; } }
  .section {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }
  .section-header {
    padding: 16px 20px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--border);
  }
  .section-title { font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
  .section-count {
    font-size: 11px; color: var(--text-secondary); background: var(--bg-input);
    padding: 2px 8px; border-radius: 10px;
  }
  .section-body { padding: 0; max-height: 400px; overflow-y: auto; }
  .section-body::-webkit-scrollbar { width: 4px; }
  .section-body::-webkit-scrollbar-track { background: transparent; }
  .section-body::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

  /* ─── Bot Row ─── */
  .bot-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 20px;
    border-bottom: 1px solid var(--border);
    transition: background 0.15s;
  }
  .bot-row:last-child { border-bottom: none; }
  .bot-row:hover { background: var(--bg-card-hover); }
  .bot-info { display: flex; align-items: center; gap: 10px; }
  .bot-avatar {
    width: 32px; height: 32px; border-radius: 8px;
    display: flex; align-items: center; justify-content: center;
    font-size: 14px; font-weight: 600;
  }
  .bot-avatar.online { background: var(--glow-green); color: var(--accent-green); }
  .bot-avatar.offline { background: var(--glow-red); color: var(--accent-red); }
  .bot-name { font-size: 13px; font-weight: 500; }
  .bot-endpoint { font-size: 11px; color: var(--text-tertiary); font-family: monospace; }
  .status-badge {
    font-size: 10px; font-weight: 500; padding: 3px 8px; border-radius: 10px;
  }
  .status-badge.online { background: var(--glow-green); color: var(--accent-green); }
  .status-badge.offline { background: var(--glow-red); color: var(--accent-red); }

  /* ─── Session Row ─── */
  .session-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 20px;
    border-bottom: 1px solid var(--border);
  }
  .session-row:last-child { border-bottom: none; }
  .session-id { font-size: 13px; font-weight: 500; }
  .session-meta { font-size: 11px; color: var(--text-secondary); }
  .session-count { font-size: 12px; color: var(--accent-blue); font-weight: 600; }

  /* ─── Error Row ─── */
  .error-row {
    padding: 10px 20px;
    border-bottom: 1px solid var(--border);
    font-family: monospace;
    font-size: 11px;
    line-height: 1.6;
  }
  .error-row:last-child { border-bottom: none; }
  .error-time { color: var(--text-tertiary); }
  .error-path { color: var(--accent-yellow); }
  .error-msg { color: var(--accent-red); }

  /* ─── Send Message Panel ─── */
  .send-section {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 20px;
    margin-bottom: 24px;
  }
  .send-form { display: flex; gap: 12px; margin-top: 12px; }
  .send-input {
    flex: 1; padding: 10px 14px; border-radius: var(--radius);
    border: 1px solid var(--border); background: var(--bg-input);
    color: var(--text-primary); font-size: 13px; font-family: inherit;
    transition: border-color 0.15s;
    outline: none;
  }
  .send-input:focus { border-color: var(--accent-blue); }
  .send-input::placeholder { color: var(--text-tertiary); }
  .send-btn {
    padding: 10px 20px; border-radius: var(--radius);
    background: linear-gradient(135deg, #2563eb, #7c3aed);
    color: white; font-size: 13px; font-weight: 500;
    border: none; cursor: pointer; transition: all 0.15s;
    white-space: nowrap;
  }
  .send-btn:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(37,99,235,0.4); }
  .send-btn:active { transform: scale(0.98); }
  .send-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
  .send-result { font-size: 12px; margin-top: 8px; padding: 8px 12px; border-radius: 8px; }
  .send-result.success { background: var(--glow-green); color: var(--accent-green); }
  .send-result.error { background: var(--glow-red); color: var(--accent-red); }

  /* ─── Empty State ─── */
  .empty { padding: 32px; text-align: center; color: var(--text-tertiary); font-size: 12px; }

  /* ─── Animations ─── */
  @keyframes fade-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  .animate-in { animation: fade-in 0.3s ease-out; }
  .stat-value { transition: all 0.3s ease-out; }
</style>
</head>
<body>

<div class="header">
  <div class="header-left">
    <div class="header-logo">J</div>
    <div>
      <div class="header-title">Jarvis Control Center</div>
      <div class="header-subtitle">Knox Message Server Monitor</div>
    </div>
  </div>
  <div class="live-badge"><div class="live-dot"></div>LIVE</div>
</div>

<div class="main">
  <div class="stats-grid" id="stats-grid"></div>

  <div class="send-section animate-in">
    <div class="section-title" style="margin-bottom:4px">
      <span>📨</span> 임직원에게 메시지 전송 (Jarvis 계정)
    </div>
    <div style="font-size:11px;color:var(--text-secondary)">Knox Portal ID로 검색하여 메시지를 전송합니다</div>
    <div class="send-form">
      <input class="send-input" id="targetId" placeholder="Knox ID (예: syngha.han)" style="max-width:200px" />
      <input class="send-input" id="msgContent" placeholder="메시지 내용" />
      <button class="send-btn" id="sendBtn" onclick="sendMessage()">전송</button>
    </div>
    <div id="sendResult" style="display:none"></div>
  </div>

  <div class="sections-grid">
    <div class="section animate-in">
      <div class="section-header">
        <div class="section-title"><span>🤖</span> 등록된 봇 <span class="section-count" id="bot-count">0</span></div>
      </div>
      <div class="section-body" id="bots-list"><div class="empty">로딩 중...</div></div>
    </div>
    <div class="section animate-in">
      <div class="section-header">
        <div class="section-title"><span>👥</span> 활성 세션 (24h) <span class="section-count" id="session-count">0</span></div>
      </div>
      <div class="section-body" id="sessions-list"><div class="empty">로딩 중...</div></div>
    </div>
  </div>

  <div class="section animate-in">
    <div class="section-header">
      <div class="section-title"><span>⚠️</span> 최근 에러 <span class="section-count" id="error-count">0</span></div>
    </div>
    <div class="section-body" id="errors-list"><div class="empty">에러 없음</div></div>
  </div>
</div>

<script>
const TOKEN = '${token}';
const API = '/dashboard/api';

function fmt(n) { return n.toLocaleString(); }
function timeAgo(iso) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return s + '초 전';
  if (s < 3600) return Math.floor(s/60) + '분 전';
  if (s < 86400) return Math.floor(s/3600) + '시간 전';
  return Math.floor(s/86400) + '일 전';
}
function uptimeStr(s) {
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60);
  return h > 0 ? h+'h '+m+'m' : m+'m';
}

function renderStats(d) {
  const cards = [
    { label: 'UPTIME', value: uptimeStr(d.server.uptime), color: 'cyan' },
    { label: 'BOTS ONLINE', value: d.server.botsOnline+'/'+d.server.botsRegistered, color: 'green' },
    { label: 'WEBHOOKS', value: fmt(d.messages.webhooksReceived), color: 'blue' },
    { label: 'FORWARDED', value: fmt(d.messages.webhooksForwarded), color: 'green' },
    { label: 'FAILED', value: fmt(d.messages.webhooksFailed), color: 'red' },
    { label: 'KNOX SENT', value: fmt(d.messages.messagesSent), color: 'purple' },
    { label: 'REDIS MEM', value: d.server.redisMemory, color: 'yellow' },
  ];
  document.getElementById('stats-grid').innerHTML = cards.map(c =>
    '<div class="stat-card '+c.color+'"><div class="stat-label">'+c.label+'</div><div class="stat-value '+c.color+'">'+c.value+'</div></div>'
  ).join('');
}

function renderBots(bots) {
  document.getElementById('bot-count').textContent = bots.length;
  if (!bots.length) { document.getElementById('bots-list').innerHTML = '<div class="empty">등록된 봇 없음</div>'; return; }
  document.getElementById('bots-list').innerHTML = bots.map(b =>
    '<div class="bot-row">' +
      '<div class="bot-info">' +
        '<div class="bot-avatar '+(b.online?'online':'offline')+'">'+(b.online?'ON':'OFF')+'</div>' +
        '<div><div class="bot-name">'+b.knoxUserId+'</div><div class="bot-endpoint">'+b.endpoint+'</div></div>' +
      '</div>' +
      '<div><span class="status-badge '+(b.online?'online':'offline')+'">'+(b.online?'Online':'Offline · '+timeAgo(b.lastSeen))+'</span></div>' +
    '</div>'
  ).join('');
}

function renderSessions(sessions) {
  document.getElementById('session-count').textContent = sessions.length;
  if (!sessions.length) { document.getElementById('sessions-list').innerHTML = '<div class="empty">활성 세션 없음</div>'; return; }
  document.getElementById('sessions-list').innerHTML = sessions.map(s =>
    '<div class="session-row">' +
      '<div><div class="session-id">'+s.loginId+'</div><div class="session-meta">'+timeAgo(s.lastActive)+'</div></div>' +
      '<div class="session-count">'+s.messageCount+'건</div>' +
    '</div>'
  ).join('');
}

function renderErrors(errors) {
  document.getElementById('error-count').textContent = errors.length;
  if (!errors.length) { document.getElementById('errors-list').innerHTML = '<div class="empty">에러 없음</div>'; return; }
  document.getElementById('errors-list').innerHTML = errors.map(e =>
    '<div class="error-row"><span class="error-time">'+e.time.slice(11,19)+'</span> <span class="error-path">'+e.path+'</span> <span class="error-msg">'+e.error.slice(0,120)+'</span></div>'
  ).join('');
}

async function refresh() {
  try {
    const res = await fetch(API+'/stats?token='+TOKEN);
    if (res.status === 401) { location.href = '/dashboard'; return; }
    const d = await res.json();
    renderStats(d);
    renderBots(d.bots);
    renderSessions(d.sessions);
    renderErrors(d.errors);
  } catch(e) { console.error('Refresh failed:', e); }
}

async function sendMessage() {
  const target = document.getElementById('targetId').value.trim();
  const msg = document.getElementById('msgContent').value.trim();
  const resultEl = document.getElementById('sendResult');
  if (!target || !msg) { resultEl.className='send-result error'; resultEl.textContent='ID와 메시지를 입력하세요'; resultEl.style.display='block'; return; }

  document.getElementById('sendBtn').disabled = true;
  document.getElementById('sendBtn').textContent = '전송 중...';

  try {
    const res = await fetch(API+'/send?token='+TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetLoginId: target, message: msg }),
    });
    const d = await res.json();
    if (d.success) {
      resultEl.className='send-result success';
      resultEl.textContent='전송 완료 (chatroom: '+d.chatroomId+')';
      document.getElementById('msgContent').value = '';
    } else {
      resultEl.className='send-result error';
      resultEl.textContent='전송 실패: '+(d.error||'Unknown');
    }
  } catch(e) {
    resultEl.className='send-result error';
    resultEl.textContent='네트워크 오류: '+e.message;
  }
  resultEl.style.display='block';
  document.getElementById('sendBtn').disabled = false;
  document.getElementById('sendBtn').textContent = '전송';
  setTimeout(() => { resultEl.style.display='none'; }, 5000);
}

// 초기 로드 + 5초 자동 갱신
refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;
}
