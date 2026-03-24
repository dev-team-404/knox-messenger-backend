/**
 * WebSocket Pub/Sub — Blue/Green cross-instance message routing
 *
 * When a Knox webhook arrives at Green but the bot is connected to Blue,
 * this module routes the message via Redis Pub/Sub.
 */

import { WebSocket } from 'ws';
import { getRedis } from './bot-registry.js';
import { wlog } from '../middleware/logger.js';
import type { WSManager } from './ws-manager.js';
import type { BotTaskRequest } from '../types.js';

const CHANNEL = 'ws-deliver';

export function initWSPubSub(wsManager: WSManager): void {
  const redis = getRedis();
  const subscriber = redis.duplicate();

  subscriber.subscribe(CHANNEL).then(() => {
    wlog.info('WS Pub/Sub subscribed', { channel: CHANNEL });
  }).catch((err) => {
    wlog.error('WS Pub/Sub subscribe failed', { error: String(err) });
  });

  subscriber.on('message', (channel, data) => {
    if (channel !== CHANNEL) return;
    try {
      const { knoxUserId, messageId, taskRequest } = JSON.parse(data) as {
        knoxUserId: string;
        messageId: string;
        taskRequest: BotTaskRequest;
      };

      const session = wsManager.getSession(knoxUserId);
      if (session && session.ws.readyState === WebSocket.OPEN) {
        wsManager.send(session.ws, {
          type: 'message',
          id: messageId,
          timestamp: Date.now(),
          payload: taskRequest,
        });
        wlog.info('WS Pub/Sub delivered cross-instance message', { knoxUserId, messageId });
      }
    } catch (err) {
      wlog.error('WS Pub/Sub message handling error', { error: String(err) });
    }
  });

  subscriber.on('error', (err) => {
    wlog.error('WS Pub/Sub subscriber error', { error: String(err) });
  });
}
