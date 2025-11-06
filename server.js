// server.js - noVNC-ocloudview 主服务器 (更新版)

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const net = require('net');
const { body, param, query, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const WebsockifyProxy = require('./lib/websockify-proxy');
const { handleVNCConnection } = require('./lib/websocket-handler');
require('dotenv').config();

// ===== 配置 =====
const config = {
  server: {
    port: process.env.PORT || 3000,
    env: process.env.NODE_ENV || 'development',
  },
  ocloudview: {
    apiUrl: process.env.OCLOUDVIEW_API_URL || 'http://172.16.31.100:8001',
    timeout: 30000,
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'your-secret-key-change-in-production',
    expiresIn: process.env.JWT_EXPIRES_IN || '24h',
  },
  websocket: {
    path: process.env.WEBSOCKET_PATH || '/vnc',
    heartbeat: {
      interval: 30000,
      timeout: 60000,
    },
  },
  vnc: {
    defaultPort: 5900,
    connectionTimeout: 10000,
  },
  cors: {
    origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:3000'],
    credentials: true,
  },
};

// ===== Express 应用初始化 =====
const app = express();

// 安全中间件
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "ws:", "wss:"],
    },
  },
}));

app.use(cors(config.cors));
app.use(morgan('combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 静态文件服务
app.use(express.static(path.join(__dirname, 'public')));

// 速率限制
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
});
app.use('/api', limiter);

// ===== 工具函数 =====
// Base64 编码密码
function encodePassword(password) {
  return Buffer.from(password).toString('base64');
}

// Base64 解码密码
function decodePassword(encodedPassword) {
  return Buffer.from(encodedPassword, 'base64').toString('utf-8');
}

// ===== ocloudview API 服务类 =====
class OcloudviewService {
  constructor() {
    this.client = axios.create({
      baseURL: config.ocloudview.apiUrl,
      timeout: config.ocloudview.timeout,
      headers: { 'Content-Type': 'application/json' },
    });

    // 请求拦截器
    this.client.interceptors.request.use(
      (request) => {
        console.log(`🔄 API Request: ${request.method?.toUpperCase()} ${request.url}`);
        return request;
      },
      (error) => Promise.reject(error)
    );

    // 响应拦截器
    this.client.interceptors.response.use(
      (response) => {
        console.log(`✅ API Response: ${response.status} ${response.config.url}`);
        return response;
      },
      (error) => {
        console.error('❌ API Response Error:', error.response?.status, error.message);
        return Promise.reject(this.handleApiError(error));
      }
    );
  }

  handleApiError(error) {
    if (error.response) {
      const { status, data } = error.response;
      
      // 处理 OcloudView 特定的错误码
      if (data && data.returnCode) {
        switch (data.returnCode) {
          case 5090:
            return new Error('当前密码错误');
          case 5098:
            return new Error('用户不存在');
          default:
            return new Error(data.msg || `API错误: ${data.returnCode}`);
        }
      }

      switch (status) {
        case 401:
          return new Error('未授权：请检查登录状态');
        case 403:
          return new Error('禁止访问：权限不足');
        case 404:
          return new Error('资源不存在');
        case 500:
          return new Error('ocloudview服务器错误');
        default:
          return new Error(data?.message || data?.msg || `API错误: ${status}`);
      }
    }
    return new Error('无法连接到ocloudview服务器');
  }

  // 用户登录
  async login(username, password) {
    try {
      const encodedPassword = encodePassword(password);
      const response = await this.client.post('/ocloud/usermodule/userlogin2', {
        sAMAccountName: username,
        password: encodedPassword,
      });

      const data = response.data;
      
      // 检查返回码
      if (data.returnCode !== 200) {
        throw new Error(data.msg || '登录失败');
      }

      return {
        success: true,
        token: data.token_login,
        username: data.userName,
        machines: data.machines,
        isFirstLogin: data.isFirstLogin,
      };
    } catch (error) {
      throw new Error('登录失败: ' + error.message);
    }
  }

  // 获取虚拟机列表（从登录返回的数据中解析）
  parseVMList(machines) {
    const vmList = [];
    
    // 处理独立虚拟机
    if (machines.domain && Array.isArray(machines.domain)) {
      machines.domain.forEach(vm => {
        vmList.push({
          id: vm.id,
          name: vm.name,
          status: this.getVMStatus(vm.status),
          cpu: vm.cpu,
          memory: Math.round(vm.memory / 1024), // 转换为GB
          os: vm.osEdition || vm.osType,
          ip: vm.originalIp || '-',
          type: 'domain',
          hostId: vm.hostId,
          isConnected: vm.isConnected,
        });
      });
    }

    // 处理桌面池虚拟机
    if (machines.desk_pool && Array.isArray(machines.desk_pool)) {
      machines.desk_pool.forEach(vm => {
        vmList.push({
          id: vm.id,
          name: vm.name,
          status: this.getVMStatus(vm.status),
          cpu: vm.cpu || '-',
          memory: vm.memory ? Math.round(vm.memory / 1024) : '-',
          os: vm.osEdition || '-',
          ip: vm.ip || '-',
          type: 'desk_pool',
          poolId: vm.poolId,
        });
      });
    }

    return vmList;
  }

  // 转换虚拟机状态
  getVMStatus(statusCode) {
    // 状态码映射（根据 OcloudView 实际定义调整）
    const statusMap = {
      0: 'stopped',
      1: 'running',
      2: 'suspended',
      3: 'paused',
      4: 'shutoff',
      5: 'crashed',
    };
    return statusMap[statusCode] || 'unknown';
  }

  // 获取虚拟机连接信息 (doubleclick2)
  async getVMConnectionInfo(token, vmId) {
    try {
      const response = await this.client.post('/ocloud/usermodule/doubleclick2',
        {
          uuid: vmId,
        },
        {
          headers: { 'token_login': token },
        }
      );

      const data = response.data;
      
      if (data.returnCode !== 200) {
        throw new Error(data.msg || '获取虚拟机连接信息失败');
      }

      return {
        hostIp: data.data.hostip || data.data.ip,
        hostId: data.data.hostId,
        vmName: data.data.name,
        vmId: data.data.uuid,
        spicePort: parseInt(data.data.spiceport),
        key: data.data.key,
        domainIPs: data.data.list || [],
      };
    } catch (error) {
      throw new Error('获取虚拟机连接信息失败: ' + error.message);
    }
  }

  // 获取VNC端口
  async getVNCPort(token, vmId) {
    try {
      const response = await this.client.get(`/ocloud/v1/domain/${vmId}/port`, {
        headers: { 'token_login': token },
      });

      const data = response.data;
      
      if (data.status !== 0) {
        throw new Error(data.msg || '获取VNC端口失败');
      }

      // 从返回数据中查找VNC端口
      let vncPort = null;
      let spicePort = null;
      
      if (data.data && Array.isArray(data.data)) {
        data.data.forEach(item => {
          if (item.type === 'vnc') {
            vncPort = item.value;
          } else if (item.type === 'spice') {
            spicePort = item.value;
          }
        });
      }

      return {
        vncPort,
        spicePort,
      };
    } catch (error) {
      throw new Error('获取VNC端口失败: ' + error.message);
    }
  }

  // 获取VNC密码
  async getVNCPassword(token, vmId) {
    try {
      const response = await this.client.post(`/ocloud/usermodule/vnc-password/${vmId}`,
        {},
        {
          headers: { 'token_login': token },
        }
      );

      const data = response.data;
      
      if (data.returnCode !== 200) {
        throw new Error(data.msg || '获取VNC密码失败');
      }

      return {
        password: data.data.password, // Base64编码的密码
        decodedPassword: decodePassword(data.data.password),
      };
    } catch (error) {
      throw new Error('获取VNC密码失败: ' + error.message);
    }
  }

  // 获取完整的VNC连接信息
  async getCompleteVNCInfo(token, vmId) {
    try {
      // 1. 获取虚拟机连接信息
      const connectionInfo = await this.getVMConnectionInfo(token, vmId);
      
      // 2. 获取VNC端口
      const ports = await this.getVNCPort(token, vmId);
      
      // 3. 获取VNC密码
      const passwordInfo = await this.getVNCPassword(token, vmId);

      return {
        host: connectionInfo.hostIp,
        port: ports.vncPort,
        password: passwordInfo.decodedPassword,
        encodedPassword: passwordInfo.password,
        vmId: vmId,
        vmName: connectionInfo.vmName,
        spicePort: ports.spicePort,
      };
    } catch (error) {
      throw new Error('获取VNC连接信息失败: ' + error.message);
    }
  }
}

const ocloudviewService = new OcloudviewService();

// ===== 会话存储（简单实现，生产环境应使用 Redis） =====
const sessionStore = new Map();

// ===== 认证中间件 =====
const authMiddleware = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'No token provided',
        message: '请提供认证令牌',
      });
    }

    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, config.jwt.secret);

    // 从会话存储中获取 OcloudView token
    const sessionData = sessionStore.get(decoded.sessionId);
    
    if (!sessionData) {
      return res.status(401).json({
        success: false,
        error: 'Session expired',
        message: '会话已过期，请重新登录',
      });
    }

    req.user = {
      userId: decoded.userId,
      username: decoded.username,
      sessionId: decoded.sessionId,
    };
    req.ocloudToken = sessionData.ocloudToken;
    req.machines = sessionData.machines;

    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: 'Token expired',
        message: '令牌已过期，请重新登录',
      });
    }
    res.status(401).json({
      success: false,
      error: 'Authentication failed',
      message: '认证失败',
    });
  }
};

// ===== API 路由 =====

// 健康检查
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'novnc-ocloudview',
    version: '1.0.0',
  });
});

// 认证接口
app.post('/api/auth/login', [
  body('username').notEmpty().withMessage('用户名不能为空'),
  body('password').notEmpty().withMessage('密码不能为空'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false,
        errors: errors.array() 
      });
    }

    const { username, password } = req.body;
    
    // 调用 OcloudView 登录接口
    const loginResult = await ocloudviewService.login(username, password);

    // 生成会话ID
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // 存储 OcloudView token 和虚拟机信息
    sessionStore.set(sessionId, {
      ocloudToken: loginResult.token,
      machines: loginResult.machines,
      username: loginResult.username,
      loginTime: Date.now(),
    });

    // 生成 JWT token
    const jwtToken = jwt.sign(
      {
        userId: username,
        username: loginResult.username,
        sessionId: sessionId,
      },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn }
    );

    res.json({
      success: true,
      message: '登录成功',
      data: {
        token: jwtToken,
        user: { 
          userId: username, 
          username: loginResult.username,
        },
        expiresIn: config.jwt.expiresIn,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(401).json({
      success: false,
      error: 'Authentication failed',
      message: error.message || '登录失败',
    });
  }
});

app.post('/api/auth/logout', authMiddleware, async (req, res) => {
  try {
    // 清除会话
    sessionStore.delete(req.user.sessionId);
    res.json({ success: true, message: '登出成功' });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: 'Logout failed', 
      message: error.message 
    });
  }
});

app.post('/api/auth/refresh', authMiddleware, (req, res) => {
  // 生成新的会话ID
  const newSessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  // 复制会话数据到新会话
  const oldSession = sessionStore.get(req.user.sessionId);
  sessionStore.set(newSessionId, oldSession);
  sessionStore.delete(req.user.sessionId);

  const newToken = jwt.sign(
    {
      userId: req.user.userId,
      username: req.user.username,
      sessionId: newSessionId,
    },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );

  res.json({
    success: true,
    message: '令牌刷新成功',
    data: { token: newToken, expiresIn: config.jwt.expiresIn },
  });
});

app.get('/api/auth/verify', authMiddleware, (req, res) => {
  res.json({
    success: true,
    valid: true,
    user: req.user,
  });
});

// 虚拟机管理接口
app.get('/api/vm/list', authMiddleware, async (req, res) => {
  try {
    // 从会话中获取虚拟机列表
    const vmList = ocloudviewService.parseVMList(req.machines);
    
    // 支持搜索和过滤
    let filteredList = vmList;
    
    if (req.query.search) {
      const searchTerm = req.query.search.toLowerCase();
      filteredList = vmList.filter(vm => 
        vm.name.toLowerCase().includes(searchTerm) ||
        vm.id.toLowerCase().includes(searchTerm)
      );
    }
    
    if (req.query.status && req.query.status !== 'all') {
      filteredList = filteredList.filter(vm => vm.status === req.query.status);
    }

    res.json({ 
      success: true, 
      data: filteredList,
      total: filteredList.length,
    });
  } catch (error) {
    console.error('Get VM list error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get VM list',
      message: error.message,
    });
  }
});

app.get('/api/vm/:id', authMiddleware, async (req, res) => {
  try {
    const vmId = req.params.id;
    const vmList = ocloudviewService.parseVMList(req.machines);
    const vm = vmList.find(v => v.id === vmId);
    
    if (!vm) {
      return res.status(404).json({
        success: false,
        error: 'VM not found',
        message: '虚拟机不存在',
      });
    }

    res.json({ success: true, data: vm });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get VM detail',
      message: error.message,
    });
  }
});

// 虚拟机操作（启动、停止、重启）
app.post('/api/vm/:id/start', authMiddleware, async (req, res) => {
  try {
    // 注意：OcloudView API 可能不支持直接的启动/停止操作
    // 这里返回模拟响应，实际项目中需要根据 API 文档实现
    res.json({ 
      success: true, 
      message: '虚拟机启动命令已发送',
      data: { vmId: req.params.id }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to start VM',
      message: error.message,
    });
  }
});

app.post('/api/vm/:id/stop', authMiddleware, async (req, res) => {
  try {
    res.json({ 
      success: true, 
      message: '虚拟机停止命令已发送',
      data: { vmId: req.params.id }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to stop VM',
      message: error.message,
    });
  }
});

app.post('/api/vm/:id/restart', authMiddleware, async (req, res) => {
  try {
    res.json({ 
      success: true, 
      message: '虚拟机重启命令已发送',
      data: { vmId: req.params.id }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to restart VM',
      message: error.message,
    });
  }
});

// VNC 连接接口
app.get('/api/vnc/connect/:vmId', authMiddleware, async (req, res) => {
  try {
    const vmId = req.params.vmId;
    
    // 获取完整的VNC连接信息
    const vncInfo = await ocloudviewService.getCompleteVNCInfo(req.ocloudToken, vmId);
    
    // 生成 WebSocket URL
    const wsProtocol = req.secure ? 'wss' : 'ws';
    const wsHost = req.get('host');
    const wsUrl = `${wsProtocol}://${wsHost}${config.websocket.path}/${vmId}`;

    res.json({
      success: true,
      data: {
        ...vncInfo,
        websocketUrl: wsUrl,
        protocol: 'vnc',
      },
    });
  } catch (error) {
    console.error('Get VNC connection error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get VNC connection',
      message: error.message,
    });
  }
});

app.get('/api/vnc/token/:vmId', authMiddleware, async (req, res) => {
  try {
    const vmId = req.params.vmId;
    
    // 生成VNC访问令牌
    const vncToken = jwt.sign(
      {
        vmId,
        ocloudToken: req.ocloudToken, // 包含 OcloudView token
        timestamp: Date.now(),
      },
      config.jwt.secret,
      { expiresIn: '1h' }
    );

    res.json({
      success: true,
      data: { token: vncToken, expiresIn: '1h' },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to generate VNC token',
      message: error.message,
    });
  }
});

// API 根端点
app.get('/api', (req, res) => {
  res.json({
    message: 'noVNC-ocloudview API Service',
    version: '1.0.0',
    endpoints: {
      auth: {
        login: 'POST /api/auth/login',
        logout: 'POST /api/auth/logout',
        refresh: 'POST /api/auth/refresh',
        verify: 'GET /api/auth/verify',
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
      },
    },
  });
});

// 404 处理
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
  const status = err.status || err.statusCode || 500;
  const message = config.server.env === 'production' 
    ? 'Internal Server Error'
    : err.message;
  
  res.status(status).json({
    error: 'Server Error',
    message,
  });
});


// ===== 服务器启动 =====
const server = http.createServer(app);

// 创建WebSocket服务器
// Note: 不指定 path，以便接受所有路径的 WebSocket 连接
// 然后在连接处理器中进行路径验证
const wss = new WebSocket.Server({
  server,
  noServer: false,
  // 移除 path 限制，允许 /vnc/* 格式的路径
});

// 初始化WebsockifyProxy (基于websockify-js架构)
const wsProxy = new WebsockifyProxy({
  wss,
  heartbeatTimeout: config.websocket.heartbeat.interval,
  connectionTimeout: config.vnc.connectionTimeout,
  maxConnections: 100
});

console.log('🔌 WebsockifyProxy initialized (based on websockify-js architecture)');

// WebSocket连接处理
wss.on('connection', (ws, req) => {
  console.log(`📱 New WebSocket connection from ${req.socket.remoteAddress}`);

  // 使用新的连接处理器
  handleVNCConnection(ws, req, {
    wsProxy,
    config,
    ocloudviewService,
    sessionStore
  });
});

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
  console.log(`🔗 OcloudView API: ${config.ocloudview.apiUrl}`);
  console.log('');
  console.log('📚 API Endpoints:');
  console.log(`   Health Check: http://localhost:${PORT}/health`);
  console.log(`   API Root: http://localhost:${PORT}/api`);
  console.log('');
  console.log('🎯 Ready to accept connections!');
});

// 优雅关闭处理
const gracefulShutdown = async (signal) => {
  console.log(`\n📴 ${signal} received, starting graceful shutdown...`);

  // 关闭 WebSocket 代理和所有连接
  await wsProxy.shutdown();

  // 清理会话存储
  sessionStore.clear();

  wss.close(() => {
    console.log('✅ WebSocket server closed');
  });

  server.close(() => {
    console.log('✅ HTTP server closed');
    process.exit(0);
  });

  setTimeout(() => {
    console.error('⚠️ Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught Exception:', error);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
  gracefulShutdown('UNHANDLED_REJECTION');
});

module.exports = server;