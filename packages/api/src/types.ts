// ─── Knox Webhook (수신 메시지) ───

export interface KnoxWebhookPayload {
  chatroomId: number;
  senderId: number;
  senderName?: string;
  msgId: number;
  msgType: number;
  chatMsg: string;
  sentTime: number;
}

// ─── Bot Registry ───

export interface BotRegistration {
  knoxUserId: string;
  endpoint: string;          // http://10.x.x.1:7777
  registeredAt: string;      // ISO timestamp
  lastSeen: string;          // ISO timestamp
}

// ─── Bot ↔ Message Server ───

export interface BotTaskRequest {
  chatroomId: string;
  senderId: string;
  senderName: string;
  message: string;
  messageId: string;
}

export interface BotResponsePayload {
  chatroomId: string;
  message: string;
}

// ─── Knox API (발신) ───

export interface KnoxChatRequestBody {
  requestId: number;
  chatroomId: number;
  chatMessageParams: Array<{
    msgId: number;
    msgType: number;
    chatMsg: string;
    msgTtl?: number;
  }>;
}

export interface KnoxCreateChatroomBody {
  requestId: number;
  chatType: number;
  receivers: number[];
  chatroomTitle?: string;
}
