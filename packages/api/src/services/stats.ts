/**
 * 서버 모니터링 카운터 — 순환 참조 방지를 위해 별도 모듈
 */

export const stats = {
  startedAt: Date.now(),
  webhooksReceived: 0,
  webhooksForwarded: 0,
  webhooksFailed: 0,
  messagesSent: 0,
  messagesFailed: 0,
  errors: [] as Array<{ time: string; path: string; error: string }>,
  activeSessions: new Map<string, { loginId: string; lastActive: string; messageCount: number }>(),
};

/** 최근 에러 100개만 보관 */
export function recordError(path: string, error: string): void {
  stats.errors.push({ time: new Date().toISOString(), path, error });
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
