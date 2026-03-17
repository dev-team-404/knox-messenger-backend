// ─── Knox Webhook (수신 메시지) ───

export interface KnoxWebhookPayload {
  sender: number;               // 발신자 사용자 ID (int64)
  sentTime?: number;            // 메시지 발신 시간
  senderName?: string;          // 발신자 이름
  chatType?: string;            // "SINGLE"(0), "GROUP"(1), "BROADCAST GROUP"(2), "BROADCAST SINGLE"(5)
  chatroomId: number;           // 대화방 ID (int64)
  msgId: number;                // 메시지 ID (int64)
  msgType?: string;             // "TEXT"(0), "MEDIA"(1), "RTF"(7), "NCUSTOM"(8), "ADAPTIVE_CARD"(19)
  chatMsg: string;              // 메시지 내용
  senderKnoxId?: string;        // 발신자 Knox ID
}

// ─── Knox Webhook Headers ───

export interface KnoxWebhookHeaders {
  'content-type'?: string;      // text/plain
  botusermail?: string;         // 봇 계정 Email
  botnotitype?: string;         // "INTRO" = 대화방 개설 시 봇 먼저 발화
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
  senderKnoxId: string;
  message: string;
  messageId: string;
  chatType: string;
  msgType: string;
  isIntro: boolean;          // botNotiType === 'INTRO' (대화방 개설 첫 발화)
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
