// backend/src/app.js

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const rateLimit = require('express-rate-limit');

const config = require('./config');

// 创建Express应用
const app = express();

// ===== 中间件配置 =====

// 安全中间件
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "ws:", "wss:"],
    },
  },
}));

// CORS配置
app.use(cors(config.cors));

// 请求日志
app.use(morgan(config.logger.format));

// 解析JSON请求体
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 速率限制
const limiter = rateLimit(config.rateLimit);
app.use('/api', limiter);

// 静态文件服务（前端文件）
app.use(express.static(path.join(__dirname, '../../frontend/public')));

// ===== 路由配置 =====

// API路由
const authRouter = require('./routes/auth');
const vmRouter = require('./routes/vm');
const vncRouter = require('./routes/vnc');

app.use('/api/auth', authRouter);
app.use('/api/vm', vmRouter);
app.use('/api/vnc', vncRouter);

// 健康检查端点
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'novnc-ocloudview',
    version: '1.0.0',
  });
});

// API根端点
app.get('/api', (req, res) => {
  res.json({
    message: 'noVNC-ocloudview API Service',
    version: '1.0.0',
    endpoints: {
      auth: {
        login: 'POST /api/auth/login',
        logout: 'POST /api/auth/logout',
        refresh: 'POST /api/auth/refresh',
      },
      vm: {
        list: 'GET /api/vm/list',
        detail: 'GET /api/vm/:id',
        start: 'POST /api/vm/:id/start',
        stop: 'POST /api/vm/:id/stop',
        restart: 'POST /api/vm/:id/restart',
      },
      vnc: {
        connect: 'GET /api/vnc/connect/:vmId',
        token: 'GET /api/vnc/token/:vmId',
        password: 'GET /api/vnc/password/:vmId',
      },
    },
  });
});

// 前端路由（返回HTML页面）
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../../frontend/index.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '../../frontend/dashboard.html'));
});

app.get('/vnc/:vmId', (req, res) => {
  res.sendFile(path.join(__dirname, '../../frontend/vnc.html'));
});

// ===== 错误处理 =====

// 404处理
app.use((req, res, next) => {
  res.status(404).json({
    error: 'Not Found',
    message: 'The requested resource was not found',
    path: req.originalUrl,
  });
});

// 全局错误处理
app.use((err, req, res, next) => {
  console.error('Error:', err);

  // 默认错误状态码
  const status = err.status || err.statusCode || 500;
  
  // 生产环境不暴露详细错误信息
  const message = config.server.env === 'production' 
    ? 'Internal Server Error' 
    : err.message;

  res.status(status).json({
    error: true,
    message,
    ...(config.server.env === 'development' && { stack: err.stack }),
  });
});

module.exports = app;