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
const { handleSPICEConnection } = require('./lib/spice-handler');
const logger = require('./lib/logger');
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
    // 连接超时时间 - 对于高延迟网络场景，需要足够的时间来建立所有 SPICE 通道
    // SPICE 协议需要建立多达 17+ 个通道 (display, inputs, cursor, playback, record, usbredir, webdav 等)
    // 在高延迟场景下，每个通道的建立都需要额外时间
    connectionTimeout: parseInt(process.env.CONNECTION_TIMEOUT) || 30000, // 增加到 30 秒，支持高延迟场景
    // 连接重试配置 - 提高不稳定网络环境下的连接成功率
    maxRetries: parseInt(process.env.MAX_RETRIES) || 3, // 最大重试次数
    retryDelay: parseInt(process.env.RETRY_DELAY) || 1000, // 初始重试延迟（毫秒）
    retryBackoffMultiplier: parseFloat(process.env.RETRY_BACKOFF_MULTIPLIER) || 2, // 重试延迟倍数
  },
  cors: {
    origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:3000'],
    credentials: true,
  },
};

// ===== Express 应用初始化 =====
const app = express();

// 安全中间件 - HTTP 环境优化配置
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
      scriptSrcAttr: ["'unsafe-inline'"],  // 允许内联事件处理器
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "ws:", "wss:"],
      fontSrc: ["'self'", "data:"],
      workerSrc: ["'self'", "blob:"],
      upgradeInsecureRequests: null,  // 禁用升级不安全请求，避免 HTTP 环境下的错误
    },
  },
  crossOriginOpenerPolicy: false,  // 禁用 COOP，避免 HTTP 环境下的警告
  crossOriginResourcePolicy: { policy: "cross-origin" },  // 允许跨域资源
  crossOriginEmbedderPolicy: false,  // 禁用 COEP
  originAgentCluster: false,  // 禁用 Origin-Agent-Cluster 头
  hsts: false,  // 禁用 HSTS，避免 HTTP 环境下强制 HTTPS
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
        logger.debug(`🔄 API Request: ${request.method?.toUpperCase()} ${request.url}`);
        return request;
      },
      (error) => Promise.reject(error)
    );

    // 响应拦截器
    this.client.interceptors.response.use(
      (response) => {
        logger.debug(`✅ API Response: ${response.status} ${response.config.url}`);
        return response;
      },
      (error) => {
        logger.error('❌ API Response Error:', error.response?.status, error.message);
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

  // 获取SPICE连接信息
  async getSPICEConnectionInfo(token, vmId) {
    try {
      logger.debug(`🔄 [SPICE API] Fetching connection info for VM: ${vmId}`);
      logger.debug(`   Token preview: ${token ? token.substring(0, 20) + '...' : 'null'}`);

      // SPICE 个性化配置（默认配置）
      const defaultPersonConfig = {
        bandwidthLimit: 12,      // 带宽限制
        frameRate: 25,           // 帧率
        spiceDecodePixFormat: 1, // 解码像素格式
        spiceDecodeType: 1,      // 解码类型
        spiceEncodeFormat: 0,    // 编码格式
        spiceGameMode: 1,        // 游戏模式
        spiceMouseMode: 0        // 鼠标模式
      };

      const requestData = {
        connectType: 'ocloudview',
        personConfig: JSON.stringify(defaultPersonConfig),
        uuid: vmId,
      };

      logger.debug(`   Request data:`, {
        connectType: requestData.connectType,
        uuid: requestData.uuid,
        personConfig: defaultPersonConfig
      });

      const response = await this.client.post('/ocloud/usermodule/get-connection-info',
        requestData,
        {
          headers: {
            'token_login': token,
            'Content-Type': 'application/json'
          },
        }
      );

      logger.debug(`✅ [SPICE API] Response received:`, {
        returnCode: response.data.returnCode,
        status: response.data.status,
        hasData: !!response.data.data
      });

      const data = response.data;

      if (data.returnCode !== 200) {
        throw new Error(data.msg || '获取SPICE连接信息失败');
      }

      return {
        hostIp: data.data.hostip || data.data.ip,
        hostId: data.data.hostId,
        vmName: data.data.name,
        vmId: data.data.uuid,
        spicePort: parseInt(data.data.spiceport),
        spicePassword: data.data.key, // SPICE密码在key字段
        domainIPs: data.data.list || [],
      };
    } catch (error) {
      logger.error(`❌ [SPICE API] Error:`, error.message);
      if (error.response) {
        logger.error(`   Response status: ${error.response.status}`);
        logger.error(`   Response data:`, error.response.data);
      }
      throw new Error('获取SPICE连接信息失败: ' + error.message);
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

  // 强制重启虚拟机
  async forceReset(token, domainId) {
    try {
      logger.debug(`🔄 [Force Reset] Resetting VM: ${domainId}`);

      const response = await this.client.post(`/ocloud/usermodule/forceReset/${domainId}`,
        {},
        {
          headers: {
            'Token': token,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
        }
      );

      logger.debug(`✅ [Force Reset] Response received:`, {
        returnCode: response.data.returnCode,
        msg: response.data.msg
      });

      const data = response.data;

      if (data.returnCode !== 0) {
        throw new Error(data.msg || '强制重启失败');
      }

      return {
        success: true,
        message: data.msg || '虚拟机强制重启命令已发送',
        data: data.data || {},
      };
    } catch (error) {
      logger.error(`❌ [Force Reset] Error:`, error.message);
      if (error.response) {
        logger.error(`   Response status: ${error.response.status}`);
        logger.error(`   Response data:`, error.response.data);
      }
      throw new Error('强制重启虚拟机失败: ' + error.message);
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
    logger.error('Login error:', error);
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
    logger.error('Get VM list error:', error);
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

// 强制重启虚拟机
app.post('/api/vm/:id/force-reset', authMiddleware, async (req, res) => {
  try {
    const vmId = req.params.id;
    logger.debug(`⚡ Force reset request for VM: ${vmId}`);

    // 调用 OcloudView API 强制重启虚拟机
    const result = await ocloudviewService.forceReset(req.ocloudToken, vmId);

    res.json({
      success: true,
      message: result.message || '虚拟机强制重启命令已发送',
      data: { vmId: vmId }
    });
  } catch (error) {
    logger.error('Force reset VM error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to force reset VM',
      message: error.message,
    });
  }
});

// VNC 连接接口
app.get('/api/vnc/connect/:vmId', authMiddleware, async (req, res) => {
  try {
    const vmId = req.params.vmId;

    logger.debug(`📞 VNC connect request for VM: ${vmId}`);

    // 获取完整的VNC连接信息
    const vncInfo = await ocloudviewService.getCompleteVNCInfo(req.ocloudToken, vmId);

    logger.debug(`📊 VNC Info retrieved:`, {
      host: vncInfo.host,
      port: vncInfo.port,
      hasPassword: !!vncInfo.password,
      passwordLength: vncInfo.password ? vncInfo.password.length : 0,
      passwordPreview: vncInfo.password ? vncInfo.password.substring(0, 3) + '***' : 'null'
    });

    // 缓存 VNC 连接信息到 session（包括密码）
    // 这样 WebSocket 连接时可以使用相同的密码
    const sessionData = sessionStore.get(req.user.sessionId);
    if (sessionData) {
      if (!sessionData.vncConnections) {
        sessionData.vncConnections = new Map();
      }
      sessionData.vncConnections.set(vmId, {
        host: vncInfo.host,
        port: vncInfo.port,
        password: vncInfo.password,
        timestamp: Date.now(),
      });
      logger.debug(`✅ VNC info cached in session for VM ${vmId}`);
    }

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
    logger.error('❌ Get VNC connection error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get VNC connection',
      message: error.message,
    });
  }
});

// SPICE 连接接口
app.get('/api/spice/connect/:vmId', authMiddleware, async (req, res) => {
  try {
    const vmId = req.params.vmId;

    logger.debug(`📞 SPICE connect request for VM: ${vmId}`);

    // 获取 SPICE 连接信息
    const spiceInfo = await ocloudviewService.getSPICEConnectionInfo(req.ocloudToken, vmId);

    logger.debug(`📊 SPICE Info retrieved:`, {
      host: spiceInfo.hostIp,
      port: spiceInfo.spicePort,
      hasPassword: !!spiceInfo.spicePassword,
      passwordLength: spiceInfo.spicePassword ? spiceInfo.spicePassword.length : 0,
      passwordPreview: spiceInfo.spicePassword ? spiceInfo.spicePassword.substring(0, 8) + '***' : 'null'
    });

    // 缓存 SPICE 连接信息到 session（包括密码）
    // 这样 WebSocket 连接时可以使用相同的密码
    const sessionData = sessionStore.get(req.user.sessionId);
    if (sessionData) {
      if (!sessionData.spiceConnections) {
        sessionData.spiceConnections = new Map();
      }
      sessionData.spiceConnections.set(vmId, {
        host: spiceInfo.hostIp,
        port: spiceInfo.spicePort,
        password: spiceInfo.spicePassword,
        timestamp: Date.now(),
      });
      logger.debug(`✅ SPICE info cached in session for VM ${vmId}`);
    }

    // 生成 WebSocket URL
    const wsProtocol = req.secure ? 'wss' : 'ws';
    const wsHost = req.get('host');
    const wsUrl = `${wsProtocol}://${wsHost}/spice/${vmId}`;

    res.json({
      success: true,
      data: {
        host: spiceInfo.hostIp,
        port: spiceInfo.spicePort,
        password: spiceInfo.spicePassword,
        vmId: spiceInfo.vmId,
        vmName: spiceInfo.vmName,
        websocketUrl: wsUrl,
        protocol: 'spice',
      },
    });
  } catch (error) {
    logger.error('❌ Get SPICE connection error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get SPICE connection',
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
  logger.error('Error:', err);
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
  // Handle WebSocket subprotocols (SPICE client uses 'binary' subprotocol)
  handleProtocols: (protocols, request) => {
    logger.debug(`🔌 [WebSocket] Client requested protocols: ${Array.from(protocols).join(', ')}`);

    // Accept 'binary' subprotocol for SPICE connections
    if (protocols.has('binary')) {
      logger.debug(`   ✅ Accepting 'binary' subprotocol`);
      return 'binary';
    }

    // For VNC or other connections, accept the first protocol or empty string
    const firstProtocol = protocols.values().next().value;
    if (firstProtocol) {
      logger.debug(`   ✅ Accepting '${firstProtocol}' subprotocol`);
      return firstProtocol;
    }

    logger.debug(`   ℹ️  No subprotocol requested, accepting connection anyway`);
    return false; // No subprotocol
  }
});

// 初始化WebsockifyProxy (基于websockify-js架构)
const wsProxy = new WebsockifyProxy({
  wss,
  heartbeatTimeout: config.websocket.heartbeat.interval,
  connectionTimeout: config.vnc.connectionTimeout,
  maxConnections: 100,
  // 连接重试配置
  maxRetries: config.vnc.maxRetries,
  retryDelay: config.vnc.retryDelay,
  retryBackoffMultiplier: config.vnc.retryBackoffMultiplier
});

logger.info('🔌 WebsockifyProxy initialized (based on websockify-js architecture)');

// WebSocket连接处理
wss.on('connection', (ws, req) => {
  logger.debug(`📱 New WebSocket connection from ${req.socket.remoteAddress}`);

  const urlPath = req.url.split('?')[0];

  // 根据路径选择处理器
  if (urlPath.startsWith('/vnc/')) {
    // 使用 VNC 连接处理器
    handleVNCConnection(ws, req, {
      wsProxy,
      config,
      ocloudviewService,
      sessionStore
    });
  } else if (urlPath.startsWith('/spice/')) {
    // 使用 SPICE 连接处理器
    handleSPICEConnection(ws, req, {
      wsProxy,
      config,
      ocloudviewService,
      sessionStore
    });
  } else {
    logger.error(`❌ Unknown WebSocket path: ${urlPath}`);
    logger.error(`   Expected: /vnc/{vmId} or /spice/{vmId}`);
    ws.close(1002, 'Invalid path');
  }
});

wss.on('error', (error) => {
  logger.error('❌ WebSocket Server Error:', error);
});

// 启动服务器
const PORT = config.server.port;

server.listen(PORT, () => {
  logger.info('🚀 noVNC-ocloudview Server Started');
  logger.info(`📡 HTTP Server: http://localhost:${PORT}`);
  logger.info(`🔌 WebSocket Server: ws://localhost:${PORT}${config.websocket.path}`);
  logger.info(`🌍 Environment: ${config.server.env}`);
  logger.info(`🔗 OcloudView API: ${config.ocloudview.apiUrl}`);
  logger.info('');
  logger.info('📚 API Endpoints:');
  logger.info(`   Health Check: http://localhost:${PORT}/health`);
  logger.info(`   API Root: http://localhost:${PORT}/api`);
  logger.info('');
  logger.info('🎯 Ready to accept connections!');
});

// 优雅关闭处理
const gracefulShutdown = async (signal) => {
  logger.info(`\n📴 ${signal} received, starting graceful shutdown...`);

  // 关闭 WebSocket 代理和所有连接
  await wsProxy.shutdown();

  // 清理会话存储
  sessionStore.clear();

  wss.close(() => {
    logger.info('✅ WebSocket server closed');
  });

  server.close(() => {
    logger.info('✅ HTTP server closed');
    process.exit(0);
  });

  setTimeout(() => {
    logger.error('⚠️ Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  logger.error('💥 Uncaught Exception:', error);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
  gracefulShutdown('UNHANDLED_REJECTION');
});

module.exports = server;