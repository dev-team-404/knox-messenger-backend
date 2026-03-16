import 'dotenv/config';

// Knox 설정은 런타임에 갱신 가능 (device 등록, key refresh)
export const config = {
  port: parseInt(process.env.API_PORT || '3000', 10),
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },
  knox: {
    apiBaseUrl: process.env.KNOX_API_BASE_URL || '',
    accessToken: process.env.KNOX_ACCESS_TOKEN || '',
    systemId: process.env.KNOX_SYSTEM_ID || '',
    deviceId: process.env.KNOX_DEVICE_ID || '',
    encryptionKey: process.env.KNOX_ENCRYPTION_KEY || '',
  },
  botApiKey: process.env.BOT_API_KEY || '',
};
