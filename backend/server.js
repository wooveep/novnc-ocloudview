// backend/server.js

const http = require('http');
const WebSocket = require('ws');
const app = require('./src/app');
const config = require('./src/config');
const WebSocketProxy = require('./src/services/websocket');

// 创建HTTP服务器
const server = http.createServer(app);

// 创建WebSocket服务器（用于VNC连接）
const wss = new WebSocket.Server({ 
  server,
  path: config.websocket.path,
});

// 初始化WebSocket代理服务
const wsProxy = new WebSocketProxy(wss);

// WebSocket连接处理
wss.on('connection', (ws, req) => {
  console.log(`📱 New WebSocket connection from ${req.socket.remoteAddress}`);
  
  // 从URL中提取虚拟机ID
  const urlParts = req.url.split('/');
  const vmId = urlParts[urlParts.length - 1];
  
  if (!vmId) {
    console.error('❌ No VM ID provided in WebSocket connection');
    ws.close(1002, 'VM ID required');
    return;
  }

  // 处理VNC代理连接
  wsProxy.handleConnection(ws, vmId, req);
});

// WebSocket服务器错误处理
wss.on('error', (error) => {
  console.error('❌ WebSocket Server Error:', error);
});

// 启动服务器
const PORT = config.server.port;

server.listen(PORT, () => {
  console.log('🚀 noVNC-ocloudview Server Started');
  console.log(`📡 HTTP Server: http://localhost:${PORT}`);
  console.log(`🔌 WebSocket Server: ws://localhost:${PORT}${config.websocket.path}`);
  console.log(`🌍 Environment: ${config.server.env}`);
  console.log('');
  console.log('📚 API Endpoints:');
  console.log(`   Health Check: http://localhost:${PORT}/health`);
  console.log(`   API Root: http://localhost:${PORT}/api`);
  console.log('');
  console.log('🎯 Ready to accept connections!');
});

// 优雅关闭处理
const gracefulShutdown = (signal) => {
  console.log(`\n📴 ${signal} received, starting graceful shutdown...`);
  
  // 关闭WebSocket服务器
  wss.close(() => {
    console.log('✅ WebSocket server closed');
  });

  // 关闭HTTP服务器
  server.close(() => {
    console.log('✅ HTTP server closed');
    process.exit(0);
  });

  // 强制退出超时（10秒）
  setTimeout(() => {
    console.error('⚠️ Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
};

// 监听终止信号
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// 未捕获的异常处理
process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught Exception:', error);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
  gracefulShutdown('UNHANDLED_REJECTION');
});

module.exports = server;