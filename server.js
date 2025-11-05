// server.js - noVNC-ocloudview 主服务器

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
require('dotenv').config();

// ===== 配置 =====
const config = {
  server: {
    port: process.env.PORT || 3000,
    env: process.env.NODE_ENV || 'development',
  },
  ocloudview: {
    apiUrl: process.env.OCLOUDVIEW_API_URL || 'http://192.168.40.161:8088',
    apiKey: process.env.OCLOUDVIEW_API_KEY || '',
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
    passwordEncryption: process.env.VNC_PASSWORD_ENCRYPTION === 'true',
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
        if (config.ocloudview.apiKey) {
          request.headers['X-API-Key'] = config.ocloudview.apiKey;
        }
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
      switch (status) {
        case 401:
          return new Error('未授权：请检查API认证信息');
        case 403:
          return new Error('禁止访问：权限不足');
        case 404:
          return new Error('资源不存在');
        case 500:
          return new Error('ocloudview服务器错误');
        default:
          return new Error(data?.message || `API错误: ${status}`);
      }
    }
    return new Error('无法连接到ocloudview服务器');
  }

  async login(username, password) {
    try {
      const response = await this.client.post('/open-api/v1/auth/login', {
        username,
        password,
      });
      return response.data;
    } catch (error) {
      throw new Error('登录失败: ' + error.message);
    }
  }

  async logout(token) {
    try {
      const response = await this.client.post('/open-api/v1/auth/logout', {}, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      return response.data;
    } catch (error) {
      throw new Error('登出失败: ' + error.message);
    }
  }

  async getVMList(token, params = {}) {
    try {
      const response = await this.client.get('/open-api/v1/domain', {
        headers: { 'Authorization': `Bearer ${token}` },
        params,
      });
      return response.data;
    } catch (error) {
      throw new Error('获取虚拟机列表失败: ' + error.message);
    }
  }

  async getVMDetail(token, vmId) {
    try {
      const response = await this.client.get(`/open-api/v1/domain/${vmId}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      return response.data;
    } catch (error) {
      throw new Error('获取虚拟机详情失败: ' + error.message);
    }
  }

  async startVM(token, vmId) {
    try {
      const response = await this.client.post(`/open-api/v1/domain/${vmId}/start`, {}, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      return response.data;
    } catch (error) {
      throw new Error('启动虚拟机失败: ' + error.message);
    }
  }

  async stopVM(token, vmId) {
    try {
      const response = await this.client.post(`/open-api/v1/domain/${vmId}/stop`, {}, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      return response.data;
    } catch (error) {
      throw new Error('停止虚拟机失败: ' + error.message);
    }
  }

  async restartVM(token, vmId) {
    try {
      const response = await this.client.post(`/open-api/v1/domain/${vmId}/restart`, {}, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      return response.data;
    } catch (error) {
      throw new Error('重启虚拟机失败: ' + error.message);
    }
  }

  async getVNCConnection(token, vmId) {
    try {
      // 获取VNC端口
      const portResponse = await this.client.get(`/open-api/v1/domain/${vmId}/port`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });

      // 获取VNC密码
      const passwordResponse = await this.client.get(`/open-api/v1/domain/${vmId}/vnc-password`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });

      // 获取虚拟机详情
      const vmDetail = await this.getVMDetail(token, vmId);

      return {
        host: vmDetail.host || 'localhost',
        port: portResponse.data.port || config.vnc.defaultPort,
        password: passwordResponse.data.password || '',
        vmId: vmId,
        vmName: vmDetail.name || '',
      };
    } catch (error) {
      throw new Error('获取VNC连接信息失败: ' + error.message);
    }
  }

  async checkVMPermission(token, vmId) {
    try {
      await this.getVMDetail(token, vmId);
      return true;
    } catch (error) {
      if (error.message.includes('404') || error.message.includes('403')) {
        return false;
      }
      throw error;
    }
  }
}

const ocloudviewService = new OcloudviewService();

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

    req.user = {
      userId: decoded.userId,
      username: decoded.username,
    };
    req.userToken = token;

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
        error: 'Validation failed',
        errors: errors.array() 
      });
    }

    const { username, password } = req.body;
    const authResult = await ocloudviewService.login(username, password);

    const token = jwt.sign(
      {
        userId: authResult.userId,
        username: username,
        timestamp: Date.now(),
      },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn }
    );

    res.json({
      success: true,
      message: '登录成功',
      data: {
        token,
        user: { userId: authResult.userId, username },
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
    await ocloudviewService.logout(req.userToken);
    res.json({ success: true, message: '登出成功' });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Logout failed', message: error.message });
  }
});

app.post('/api/auth/refresh', authMiddleware, (req, res) => {
  const newToken = jwt.sign(
    {
      userId: req.user.userId,
      username: req.user.username,
      timestamp: Date.now(),
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
    const params = {
      page: parseInt(req.query.page) || 1,
      pageSize: parseInt(req.query.pageSize) || 20,
      search: req.query.search || '',
      status: req.query.status || 'all',
    };

    const vmList = await ocloudviewService.getVMList(req.userToken, params);
    res.json({ success: true, data: vmList });
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
    const vmDetail = await ocloudviewService.getVMDetail(req.userToken, req.params.id);
    res.json({ success: true, data: vmDetail });
  } catch (error) {
    if (error.message.includes('404')) {
      return res.status(404).json({
        success: false,
        error: 'VM not found',
        message: '虚拟机不存在',
      });
    }
    res.status(500).json({
      success: false,
      error: 'Failed to get VM detail',
      message: error.message,
    });
  }
});

app.post('/api/vm/:id/start', authMiddleware, async (req, res) => {
  try {
    const vmId = req.params.id;
    const hasPermission = await ocloudviewService.checkVMPermission(req.userToken, vmId);
    
    if (!hasPermission) {
      return res.status(403).json({
        success: false,
        error: 'Permission denied',
        message: '无权限操作此虚拟机',
      });
    }

    const result = await ocloudviewService.startVM(req.userToken, vmId);
    res.json({ success: true, message: '虚拟机启动成功', data: result });
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
    const vmId = req.params.id;
    const hasPermission = await ocloudviewService.checkVMPermission(req.userToken, vmId);
    
    if (!hasPermission) {
      return res.status(403).json({
        success: false,
        error: 'Permission denied',
        message: '无权限操作此虚拟机',
      });
    }

    const result = await ocloudviewService.stopVM(req.userToken, vmId);
    res.json({ success: true, message: '虚拟机停止成功', data: result });
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
    const vmId = req.params.id;
    const hasPermission = await ocloudviewService.checkVMPermission(req.userToken, vmId);
    
    if (!hasPermission) {
      return res.status(403).json({
        success: false,
        error: 'Permission denied',
        message: '无权限操作此虚拟机',
      });
    }

    const result = await ocloudviewService.restartVM(req.userToken, vmId);
    res.json({ success: true, message: '虚拟机重启成功', data: result });
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
    const hasPermission = await ocloudviewService.checkVMPermission(req.userToken, vmId);
    
    if (!hasPermission) {
      return res.status(403).json({
        success: false,
        error: 'Permission denied',
        message: '无权限访问此虚拟机',
      });
    }

    const vncInfo = await ocloudviewService.getVNCConnection(req.userToken, vmId);
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
    const vncInfo = await ocloudviewService.getVNCConnection(req.userToken, vmId);
    
    const vncToken = jwt.sign(
      {
        vmId,
        host: vncInfo.host,
        port: vncInfo.port,
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

// ===== WebSocket 代理 =====
class WebSocketProxy {
  constructor(wss) {
    this.wss = wss;
    this.connections = new Map();
    this.heartbeatInterval = null;
    this.startHeartbeat();
  }

  async handleConnection(ws, vmId, req) {
    console.log(`🔌 New VNC WebSocket connection for VM: ${vmId}`);

    try {
      const token = this.extractToken(req);
      
      if (!token) {
        console.error('❌ No authentication token provided');
        ws.send(JSON.stringify({ error: 'Authentication required' }));
        ws.close(1008, 'Authentication required');
        return;
      }

      const vncInfo = await this.verifyAndGetVNCInfo(token, vmId);
      
      if (!vncInfo) {
        console.error('❌ Failed to get VNC connection info');
        ws.send(JSON.stringify({ error: 'Failed to connect to VM' }));
        ws.close(1008, 'Connection failed');
        return;
      }

      const vncConnection = this.createVNCConnection(vncInfo);
      this.setupProxy(ws, vncConnection, vmId);
      
      this.connections.set(vmId, {
        ws,
        vncConnection,
        startTime: Date.now(),
        lastActivity: Date.now(),
      });

    } catch (error) {
      console.error('❌ WebSocket connection error:', error);
      ws.send(JSON.stringify({ error: error.message }));
      ws.close(1011, 'Internal error');
    }
  }

  extractToken(req) {
    const urlParams = new URLSearchParams(req.url.split('?')[1]);
    const queryToken = urlParams.get('token');
    if (queryToken) return queryToken;

    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }

    return null;
  }

  async verifyAndGetVNCInfo(token, vmId) {
    try {
      try {
        const decoded = jwt.verify(token, config.jwt.secret);
        if (decoded.vmId === vmId) {
          return {
            host: decoded.host,
            port: decoded.port,
            vmId: decoded.vmId,
          };
        }
      } catch (e) {
        // 不是VNC令牌，尝试作为用户令牌使用
      }

      return await ocloudviewService.getVNCConnection(token, vmId);
    } catch (error) {
      console.error('Token verification error:', error);
      return null;
    }
  }

  createVNCConnection(vncInfo) {
    const { host, port } = vncInfo;
    console.log(`📡 Connecting to VNC server: ${host}:${port}`);
    
    const connection = net.createConnection({
      host,
      port,
      timeout: config.vnc.connectionTimeout,
    });

    connection.on('connect', () => {
      console.log(`✅ Connected to VNC server: ${host}:${port}`);
    });

    connection.on('error', (error) => {
      console.error(`❌ VNC connection error: ${error.message}`);
    });

    connection.on('timeout', () => {
      console.error(`⏱️ VNC connection timeout`);
      connection.destroy();
    });

    return connection;
  }

  setupProxy(ws, vncConnection, vmId) {
    let isAlive = true;

    ws.on('pong', () => {
      isAlive = true;
      this.updateActivity(vmId);
    });

    ws.on('message', (data) => {
      try {
        this.updateActivity(vmId);
        
        if (Buffer.isBuffer(data)) {
          vncConnection.write(data);
        } else {
          const message = JSON.parse(data.toString());
          this.handleControlMessage(message, ws, vncConnection);
        }
      } catch (error) {
        console.error('WebSocket message error:', error);
        vncConnection.write(Buffer.from(data));
      }
    });

    vncConnection.on('data', (data) => {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
          this.updateActivity(vmId);
        }
      } catch (error) {
        console.error('VNC data forwarding error:', error);
      }
    });

    ws.on('close', () => {
      console.log(`🔌 WebSocket closed for VM: ${vmId}`);
      vncConnection.end();
      this.connections.delete(vmId);
    });

    ws.on('error', (error) => {
      console.error(`WebSocket error for VM ${vmId}:`, error);
      vncConnection.end();
      this.connections.delete(vmId);
    });

    vncConnection.on('close', () => {
      console.log(`📡 VNC connection closed for VM: ${vmId}`);
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1000, 'VNC connection closed');
      }
      this.connections.delete(vmId);
    });

    vncConnection.on('error', (error) => {
      console.error(`VNC error for VM ${vmId}:`, error);
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1011, 'VNC connection error');
      }
      this.connections.delete(vmId);
    });

    ws.isAlive = isAlive;
  }

  handleControlMessage(message, ws, vncConnection) {
    switch (message.type) {
      case 'resize':
        console.log(`Screen resize request: ${message.width}x${message.height}`);
        break;
      case 'quality':
        console.log(`Quality adjustment: ${message.quality}`);
        break;
      case 'clipboard':
        console.log(`Clipboard sync: ${message.data}`);
        break;
      default:
        vncConnection.write(Buffer.from(JSON.stringify(message)));
    }
  }

  updateActivity(vmId) {
    const connection = this.connections.get(vmId);
    if (connection) {
      connection.lastActivity = Date.now();
    }
  }

  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      this.connections.forEach((connection, vmId) => {
        const ws = connection.ws;
        
        if (ws.isAlive === false) {
          console.log(`💔 Terminating inactive connection for VM: ${vmId}`);
          ws.terminate();
          connection.vncConnection.end();
          this.connections.delete(vmId);
          return;
        }

        ws.isAlive = false;
        ws.ping();
      });
    }, config.websocket.heartbeat.interval);
  }

  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  cleanup() {
    console.log('🧹 Cleaning up WebSocket proxy...');
    this.stopHeartbeat();
    
    this.connections.forEach((connection, vmId) => {
      console.log(`Closing connection for VM: ${vmId}`);
      connection.ws.close(1000, 'Server shutdown');
      connection.vncConnection.end();
    });
    
    this.connections.clear();
  }
}

// ===== 服务器启动 =====
const server = http.createServer(app);

// 创建WebSocket服务器
const wss = new WebSocket.Server({ 
  server,
  path: config.websocket.path,
});

// 初始化WebSocket代理
const wsProxy = new WebSocketProxy(wss);

// WebSocket连接处理
wss.on('connection', (ws, req) => {
  console.log(`📱 New WebSocket connection from ${req.socket.remoteAddress}`);
  
  const urlParts = req.url.split('/');
  const vmId = urlParts[urlParts.length - 1].split('?')[0];
  
  if (!vmId) {
    console.error('❌ No VM ID provided in WebSocket connection');
    ws.close(1002, 'VM ID required');
    return;
  }

  wsProxy.handleConnection(ws, vmId, req);
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