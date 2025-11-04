// backend/src/config/index.js

const dotenv = require('dotenv');
const path = require('path');

// 加载环境变量
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const config = {
  // 服务器配置
  server: {
    port: process.env.PORT || 3000,
    env: process.env.NODE_ENV || 'development',
  },

  // ocloudview API配置
  ocloudview: {
    apiUrl: process.env.OCLOUDVIEW_API_URL || 'http://192.168.40.161:8088',
    apiKey: process.env.OCLOUDVIEW_API_KEY || '',
    timeout: 30000, // API请求超时时间(ms)
  },

  // JWT配置
  jwt: {
    secret: process.env.JWT_SECRET || 'your-secret-key-change-in-production',
    expiresIn: process.env.JWT_EXPIRES_IN || '24h',
  },

  // WebSocket配置
  websocket: {
    port: process.env.WEBSOCKET_PORT || 6080,
    path: process.env.WEBSOCKET_PATH || '/vnc',
    // WebSocket心跳配置
    heartbeat: {
      interval: 30000, // 心跳间隔(ms)
      timeout: 60000,  // 心跳超时(ms)
    },
  },

  // VNC配置
  vnc: {
    passwordEncryption: process.env.VNC_PASSWORD_ENCRYPTION === 'true',
    defaultPort: 5900,
    connectionTimeout: 10000, // VNC连接超时(ms)
  },

  // CORS配置
  cors: {
    origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:3000'],
    credentials: true,
  },

  // 日志配置
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    format: process.env.LOG_FORMAT || 'combined',
  },

  // 速率限制配置
  rateLimit: {
    windowMs: 15 * 60 * 1000, // 15分钟
    max: 100, // 限制每个IP 100个请求
  },

  // 会话配置
  session: {
    secret: process.env.SESSION_SECRET || 'session-secret-change-in-production',
    maxAge: 24 * 60 * 60 * 1000, // 24小时
  },
};

// 验证必要配置
function validateConfig() {
  const required = [
    'OCLOUDVIEW_API_URL',
    'JWT_SECRET',
  ];

  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0 && config.server.env === 'production') {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

// 开发环境配置检查
if (config.server.env === 'development') {
  console.log('🔧 Running in development mode');
  console.log('📝 Configuration loaded:');
  console.log(`   - Server Port: ${config.server.port}`);
  console.log(`   - ocloudview API: ${config.ocloudview.apiUrl}`);
  console.log(`   - WebSocket Port: ${config.websocket.port}`);
}

module.exports = config;