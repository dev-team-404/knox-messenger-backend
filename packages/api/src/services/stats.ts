/**
 * 서버 모니터링 카운터 — 순환 참조 방지를 위해 별도 모듈
 */

export interface ErrorRecord {
  time: string;
  path: string;
  errorType: string;
  sender?: string;
  senderName?: string;
  endpoint?: string;
  chatroomId?: string;
  detail: string;
}

export const stats = {
  startedAt: Date.now(),
  webhooksReceived: 0,
  webhooksForwarded: 0,
  webhooksFailed: 0,
  messagesSent: 0,
  messagesFailed: 0,
  errors: [] as ErrorRecord[],
  activeSessions: new Map<string, { loginId: string; lastActive: string; messageCount: number }>(),
};

/** 에러 타입 자동 분류 */
function classifyError(detail: string): string {
  const d = detail.toLowerCase();
  if (d.includes('timeout') || d.includes('aborted due to timeout')) return 'timeout';
  if (d.includes('econnrefused') || d.includes('connect econnrefused')) return 'connection_refused';
  if (d.includes('econnreset') || d.includes('socket hang up')) return 'connection_reset';
  if (d.includes('enotfound') || d.includes('getaddrinfo')) return 'dns_error';
  if (d.includes('health check failed')) return 'health_check_failed';
  if (/bot returned \d+/.test(d)) return 'http_error';
  if (d.includes('knox api')) return 'knox_api_error';
  if (d.includes('decrypt') || d.includes('parse')) return 'parse_error';
  return 'unknown';
}

/** 최근 에러 100개만 보관 (구조화) */
export function recordError(path: string, detail: string, context?: {
  errorType?: string;
  sender?: string;
  senderName?: string;
  endpoint?: string;
  chatroomId?: string;
}): void {
  stats.errors.push({
    time: new Date().toISOString(),
    path,
    errorType: context?.errorType || classifyError(detail),
    sender: context?.sender,
    senderName: context?.senderName,
    endpoint: context?.endpoint,
    chatroomId: context?.chatroomId,
    detail,
  });
  if (stats.errors.length > 100) stats.errors.shift();
}

/** 세션 추적 (메시지 내용 저장 안 함) */
export function trackSession(knoxId: string): void {
  const existing = stats.activeSessions.get(knoxId);
  stats.activeSessions.set(knoxId, {
    loginId: knoxId,
    lastActive: new Date().toISOString(),
    messageCount: (existing?.messageCount || 0) + 1,
  });
}
