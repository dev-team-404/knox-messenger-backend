/**
 * WSManager singleton — 순환 참조 방지를 위해 별도 모듈
 *
 * index.ts → routes → ws-instance.ts (단방향)
 */

import { WSManager } from './ws-manager.js';

const SERVER_ID = process.env.SERVER_ID || 'default';
export const wsManager = new WSManager(SERVER_ID);
