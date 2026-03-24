/**
 * WebSocket Session Manager
 *
 * Manages WebSocket connections from Nexus Bot clients.
 * Replaces HTTP-based forwardToBot() with persistent WS connections.
 *
 * Key responsibilities:
 * - Bot authentication (API Key + knoxUserId)
 * - Message delivery (Knox webhook → WS push to bot)
 * - Pending message queue (Redis, TTL 24h) for offline bots
 * - ACK-based delivery guarantee with dedup
 * - Response/Initiate forwarding (bot → Knox API)
 * - Blue/Green cross-instance routing via Redis Pub/Sub
 */

import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'crypto';
import type { IncomingMessage } from 'http';
import type { Server as HttpServer } from 'http';
import { config } from '../config.js';
import { getRedis } from './bot-registry.js';
import { registerBot, heartbeat as registryHeartbeat } from './bot-registry.js';
import { sendMessage, searchUserByLoginId, createChatroom } from './knox-api.js';
import { wlog } from '../middleware/logger.js';
import { stats, recordError } from './stats.js';
import type { WSEnvelope, WSAuthPayload, WSResponsePayload, WSInitiatePayload, WSAckPayload, BotTaskRequest } from '../types.js';

// ─── Types ───

interface BotSession {
  ws: WebSocket;
  knoxUserId: string;
  sessionId: string;
  connectedAt: number;
  lastActivity: number;
  authenticated: boolean;
}

// ─── Constants ───

const AUTH_TIMEOUT_MS = 5_000;
const PING_INTERVAL_MS = 30_000;
const PENDING_TTL = 86400;       // 24h
const ACK_TTL = 3600;            // 1h dedup
const PENDING_FLUSH_DELAY_MS = 100; // gap between pending messages

// ─── Redis Key Helpers ───

const sessionKey = (uid: string) => `ws-session:${uid}`;
const pendingListKey = (uid: string) => `ws-pending:${uid}`;
const pendingItemKey = (mid: string) => `ws-pending-item:${mid}`;
const ackKey = (mid: string) => `ws-ack:${mid}`;

// ─── WSManager ───

export class WSManager {
  private wss: WebSocketServer | null = null;
  private sessions = new Map<string, BotSession>();
  private serverId: string;

  constructor(serverId: string) {
    this.serverId = serverId;
  }

  /** Attach WebSocket server to an existing HTTP server */
  attach(httpServer: HttpServer): void {
    this.wss = new WebSocketServer({
      server: httpServer,
      path: '/ws',
      maxPayload: 1024 * 1024,
      perMessageDeflate: false,
    });

    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
    wlog.info('WSManager attached', { serverId: this.serverId, path: '/ws' });
  }

  // ─── Connection Lifecycle ───

  private handleConnection(ws: WebSocket, _req: IncomingMessage): void {
    const session: BotSession = {
      ws,
      knoxUserId: '',
      sessionId: crypto.randomUUID(),
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      authenticated: false,
    };

    // Auth timeout — must send 'auth' within 5s
    const authTimer = setTimeout(() => {
      if (!session.authenticated) {
        ws.close(4001, 'Authentication timeout');
      }
    }, AUTH_TIMEOUT_MS);

    // Ping/pong for connection keepalive
    const pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
      else clearInterval(pingTimer);
    }, PING_INTERVAL_MS);

    ws.on('pong', () => { session.lastActivity = Date.now(); });

    ws.on('message', async (data) => {
      try {
        const envelope = JSON.parse(data.toString()) as WSEnvelope;
        session.lastActivity = Date.now();

        if (!session.authenticated) {
          if (envelope.type === 'auth') {
            clearTimeout(authTimer);
            await this.handleAuth(session, envelope);
          } else {
            ws.close(4002, 'Authentication required');
          }
          return;
        }

        await this.handleMessage(session, envelope);
      } catch (err) {
        wlog.error('WS parse error', { error: String(err), sessionId: session.sessionId });
      }
    });

    ws.on('close', (code, reason) => {
      clearTimeout(authTimer);
      clearInterval(pingTimer);
      if (session.authenticated && session.knoxUserId) {
        this.handleDisconnect(session, code, reason.toString());
      }
    });

    ws.on('error', (err) => {
      wlog.error('WS connection error', { error: String(err), sessionId: session.sessionId });
    });
  }

  // ─── Authentication ───

  private async handleAuth(session: BotSession, envelope: WSEnvelope): Promise<void> {
    const { knoxUserId, apiKey, lastMessageId } = envelope.payload as WSAuthPayload;

    if (config.botApiKey && apiKey !== config.botApiKey) {
      stats.wsAuthFailures++;
      this.send(session.ws, { type: 'auth_error', id: envelope.id, timestamp: Date.now(), payload: { reason: 'Invalid API key' } });
      session.ws.close(4003, 'Invalid API key');
      recordError('ws:auth', 'Invalid API key', { errorType: 'ws_auth_failure', sender: knoxUserId || '(unknown)' });
      return;
    }

    if (!knoxUserId) {
      stats.wsAuthFailures++;
      this.send(session.ws, { type: 'auth_error', id: envelope.id, timestamp: Date.now(), payload: { reason: 'knoxUserId required' } });
      session.ws.close(4004, 'knoxUserId required');
      recordError('ws:auth', 'knoxUserId required', { errorType: 'ws_auth_failure' });
      return;
    }

    // Replace existing session for same user (reconnect)
    const existing = this.sessions.get(knoxUserId);
    if (existing && existing.ws.readyState === WebSocket.OPEN) {
      existing.ws.close(4005, 'Replaced by new connection');
    }

    session.knoxUserId = knoxUserId;
    session.authenticated = true;
    this.sessions.set(knoxUserId, session);
    stats.wsConnectionsTotal++;

    const redis = getRedis();

    // Store session in Redis (for cross-instance routing)
    await redis.set(sessionKey(knoxUserId), JSON.stringify({
      sessionId: session.sessionId,
      serverId: this.serverId,
      connectedAt: session.connectedAt,
    }));

    // Also register in bot registry (compatibility)
    await registerBot(knoxUserId, `ws://${this.serverId}/${session.sessionId}`);

    wlog.info('WS authenticated', { knoxUserId, sessionId: session.sessionId });

    this.send(session.ws, {
      type: 'auth_ok',
      id: envelope.id,
      timestamp: Date.now(),
      payload: { sessionId: session.sessionId },
    });

    // Deliver pending messages
    await this.deliverPendingMessages(session, lastMessageId);
  }

  // ─── Message Routing ───

  private async handleMessage(session: BotSession, envelope: WSEnvelope): Promise<void> {
    switch (envelope.type) {
      case 'response':
        await this.handleResponse(session, envelope);
        break;
      case 'initiate':
        await this.handleInitiate(session, envelope);
        break;
      case 'heartbeat':
        this.send(session.ws, { type: 'heartbeat_ack', id: envelope.id, timestamp: Date.now(), payload: {} });
        await registryHeartbeat(session.knoxUserId).catch(() => {});
        break;
      case 'ack':
        await this.handleAck(session, envelope);
        break;
      default:
        wlog.warn('WS unknown message type', { type: envelope.type, sessionId: session.sessionId });
    }
  }

  // ─── Bot → Knox Response ───

  private async handleResponse(session: BotSession, envelope: WSEnvelope): Promise<void> {
    const { chatroomId, message } = envelope.payload as WSResponsePayload;
    try {
      const success = await sendMessage(String(chatroomId), String(message));
      if (success) stats.messagesSent++;
      else stats.messagesFailed++;
      this.send(session.ws, {
        type: 'response_ack',
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        payload: { messageId: envelope.id, success },
      });
    } catch (err) {
      stats.messagesFailed++;
      recordError('ws:response', String(err), { chatroomId: String(chatroomId) });
      this.send(session.ws, {
        type: 'response_ack',
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        payload: { messageId: envelope.id, success: false, error: String(err) },
      });
    }
  }

  // ─── Bot → Knox Initiate Conversation ───

  private async handleInitiate(session: BotSession, envelope: WSEnvelope): Promise<void> {
    const { receiverId, message } = envelope.payload as WSInitiatePayload;
    try {
      let resolvedId = String(receiverId);
      if (!/^\d+$/.test(resolvedId)) {
        const knoxUserId = await searchUserByLoginId(resolvedId);
        if (!knoxUserId) {
          this.send(session.ws, {
            type: 'initiate_ack', id: crypto.randomUUID(), timestamp: Date.now(),
            payload: { messageId: envelope.id, success: false, error: `User not found: ${receiverId}` },
          });
          return;
        }
        resolvedId = knoxUserId;
      }
      const result = await createChatroom([resolvedId], 0);
      if (!result) {
        this.send(session.ws, {
          type: 'initiate_ack', id: crypto.randomUUID(), timestamp: Date.now(),
          payload: { messageId: envelope.id, success: false, error: 'Failed to create chatroom' },
        });
        return;
      }
      const sent = await sendMessage(result.chatroomId, message);
      this.send(session.ws, {
        type: 'initiate_ack', id: crypto.randomUUID(), timestamp: Date.now(),
        payload: { messageId: envelope.id, success: sent, chatroomId: result.chatroomId },
      });
    } catch (err) {
      recordError('ws:initiate', String(err));
      this.send(session.ws, {
        type: 'initiate_ack', id: crypto.randomUUID(), timestamp: Date.now(),
        payload: { messageId: envelope.id, success: false, error: String(err) },
      });
    }
  }

  // ─── Pending Message Delivery (on reconnect) ───

  private async deliverPendingMessages(session: BotSession, lastMessageId?: string): Promise<void> {
    const redis = getRedis();
    const key = pendingListKey(session.knoxUserId);
    const pendingIds = await redis.lrange(key, 0, -1);
    if (pendingIds.length === 0) return;

    const messages: Array<{ id: string; payload: BotTaskRequest; timestamp: number }> = [];
    let foundLast = !lastMessageId;

    for (const msgId of pendingIds) {
      if (!foundLast) {
        if (msgId === lastMessageId) foundLast = true;
        continue;
      }
      const raw = await redis.get(pendingItemKey(msgId));
      if (raw) {
        try {
          const item = JSON.parse(raw) as { payload: BotTaskRequest; timestamp: number };
          messages.push({ id: msgId, payload: item.payload, timestamp: item.timestamp });
        } catch { /* skip corrupted */ }
      }
    }

    if (messages.length > 0) {
      wlog.info('Delivering pending messages', { knoxUserId: session.knoxUserId, count: messages.length });
      stats.wsPendingDelivered += messages.length;
      this.send(session.ws, {
        type: 'pending_messages',
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        payload: { messages },
      });
    }
  }

  // ─── ACK Processing ───

  private async handleAck(_session: BotSession, envelope: WSEnvelope): Promise<void> {
    const { messageId } = envelope.payload as WSAckPayload;
    if (!messageId) return;
    const redis = getRedis();
    const key = pendingListKey(_session.knoxUserId);
    await redis.lrem(key, 1, messageId);
    await redis.del(pendingItemKey(messageId));
    await redis.set(ackKey(messageId), '1', 'EX', ACK_TTL);
  }

  // ─── Deliver to Bot (called from webhook) ───

  async deliverToBot(knoxUserId: string, taskRequest: BotTaskRequest, messageId: string): Promise<boolean> {
    const session = this.sessions.get(knoxUserId);

    if (session && session.ws.readyState === WebSocket.OPEN) {
      // Direct delivery via WebSocket
      this.send(session.ws, {
        type: 'message',
        id: messageId,
        timestamp: Date.now(),
        payload: taskRequest,
      });
      // Also store in pending until ACK
      await this.storePending(knoxUserId, messageId, taskRequest);
      return true;
    }

    // Bot offline on this instance — store in pending
    await this.storePending(knoxUserId, messageId, taskRequest);

    // Check if bot is on another instance (Blue/Green)
    const redis = getRedis();
    const sessionRaw = await redis.get(sessionKey(knoxUserId));
    if (sessionRaw) {
      try {
        const info = JSON.parse(sessionRaw) as { serverId: string };
        if (info.serverId !== this.serverId) {
          // Publish to other instance via Redis
          await redis.publish('ws-deliver', JSON.stringify({ knoxUserId, messageId, taskRequest }));
          return true;
        }
      } catch { /* ignore */ }
    }

    return false; // Bot not connected anywhere
  }

  // ─── Pending Storage ───

  private async storePending(knoxUserId: string, messageId: string, payload: BotTaskRequest): Promise<void> {
    const redis = getRedis();
    // Dedup: skip if already acked
    const acked = await redis.get(ackKey(messageId));
    if (acked) return;

    const key = pendingListKey(knoxUserId);
    await redis.rpush(key, messageId);
    await redis.expire(key, PENDING_TTL);
    await redis.set(pendingItemKey(messageId), JSON.stringify({
      payload,
      timestamp: Date.now(),
    }), 'EX', PENDING_TTL);
  }

  // ─── Disconnect ───

  private handleDisconnect(session: BotSession, code: number, reason: string): void {
    stats.wsDisconnectsTotal++;
    wlog.info('WS disconnected', { knoxUserId: session.knoxUserId, code, reason, sessionId: session.sessionId });
    this.sessions.delete(session.knoxUserId);

    // Clean Redis session (only if it's ours)
    const redis = getRedis();
    redis.get(sessionKey(session.knoxUserId)).then(raw => {
      if (raw) {
        try {
          const info = JSON.parse(raw) as { serverId: string };
          if (info.serverId === this.serverId) {
            redis.del(sessionKey(session.knoxUserId)).catch(() => {});
          }
        } catch { /* ignore */ }
      }
    }).catch(() => {});
  }

  // ─── Utility ───

  send(ws: WebSocket, envelope: Omit<WSEnvelope, 'id' | 'timestamp'> & { id?: string; timestamp?: number }): void {
    if (ws.readyState === WebSocket.OPEN) {
      const full: WSEnvelope = {
        id: envelope.id || crypto.randomUUID(),
        timestamp: envelope.timestamp || Date.now(),
        ...envelope,
      } as WSEnvelope;
      ws.send(JSON.stringify(full));
    }
  }

  /** Get session for a specific user (used by pubsub) */
  getSession(knoxUserId: string): BotSession | undefined {
    return this.sessions.get(knoxUserId);
  }

  /** Connection stats for dashboard */
  getConnectionStats(): { total: number; sessions: Array<{ knoxUserId: string; connectedAt: number; lastActivity: number }> } {
    const sessions = Array.from(this.sessions.values())
      .filter(s => s.authenticated)
      .map(s => ({
        knoxUserId: s.knoxUserId,
        connectedAt: s.connectedAt,
        lastActivity: s.lastActivity,
      }));
    return { total: sessions.length, sessions };
  }

  /** Graceful shutdown */
  async shutdown(): Promise<void> {
    for (const [, session] of this.sessions) {
      session.ws.close(1001, 'Server shutting down');
    }
    this.sessions.clear();
    this.wss?.close();
    wlog.info('WSManager shutdown complete');
  }
}
