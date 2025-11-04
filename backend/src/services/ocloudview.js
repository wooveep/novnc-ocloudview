// backend/src/services/ocloudview.js

const axios = require('axios');
const config = require('../config');

/**
 * ocloudview API 服务
 * 负责与ocloudview系统进行API交互
 */
class OcloudviewService {
  constructor() {
    // 创建axios实例
    this.client = axios.create({
      baseURL: config.ocloudview.apiUrl,
      timeout: config.ocloudview.timeout,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // 请求拦截器
    this.client.interceptors.request.use(
      (request) => {
        // 添加API Key（如果配置了）
        if (config.ocloudview.apiKey) {
          request.headers['X-API-Key'] = config.ocloudview.apiKey;
        }
        
        // 记录请求日志
        console.log(`🔄 API Request: ${request.method?.toUpperCase()} ${request.url}`);
        return request;
      },
      (error) => {
        console.error('❌ API Request Error:', error);
        return Promise.reject(error);
      }
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

  /**
   * 处理API错误
   */
  handleApiError(error) {
    if (error.response) {
      // 服务器响应了错误状态码
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
    } else if (error.request) {
      // 请求已发送但没有收到响应
      return new Error('无法连接到ocloudview服务器');
    } else {
      // 请求设置时发生错误
      return new Error('请求配置错误: ' + error.message);
    }
  }

  // ===== 用户认证相关 =====

  /**
   * 用户登录
   */
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

  /**
   * 用户登出
   */
  async logout(token) {
    try {
      const response = await this.client.post('/open-api/v1/auth/logout', {}, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });
      
      return response.data;
    } catch (error) {
      throw new Error('登出失败: ' + error.message);
    }
  }

  // ===== 虚拟机管理相关 =====

  /**
   * 获取虚拟机列表
   */
  async getVMList(token, params = {}) {
    try {
      const response = await this.client.get('/open-api/v1/domain', {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
        params,
      });
      
      return response.data;
    } catch (error) {
      throw new Error('获取虚拟机列表失败: ' + error.message);
    }
  }

  /**
   * 获取虚拟机详情
   */
  async getVMDetail(token, vmId) {
    try {
      const response = await this.client.get(`/open-api/v1/domain/${vmId}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });
      
      return response.data;
    } catch (error) {
      throw new Error('获取虚拟机详情失败: ' + error.message);
    }
  }

  /**
   * 启动虚拟机
   */
  async startVM(token, vmId) {
    try {
      const response = await this.client.post(`/open-api/v1/domain/${vmId}/start`, {}, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });
      
      return response.data;
    } catch (error) {
      throw new Error('启动虚拟机失败: ' + error.message);
    }
  }

  /**
   * 停止虚拟机
   */
  async stopVM(token, vmId) {
    try {
      const response = await this.client.post(`/open-api/v1/domain/${vmId}/stop`, {}, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });
      
      return response.data;
    } catch (error) {
      throw new Error('停止虚拟机失败: ' + error.message);
    }
  }

  /**
   * 重启虚拟机
   */
  async restartVM(token, vmId) {
    try {
      const response = await this.client.post(`/open-api/v1/domain/${vmId}/restart`, {}, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });
      
      return response.data;
    } catch (error) {
      throw new Error('重启虚拟机失败: ' + error.message);
    }
  }

  // ===== VNC连接相关 =====

  /**
   * 获取VNC连接信息
   * 包括VNC服务器地址、端口、密码等
   */
  async getVNCConnection(token, vmId) {
    try {
      // 获取VNC端口
      const portResponse = await this.client.get(`/open-api/v1/domain/${vmId}/port`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      // 获取VNC密码
      const passwordResponse = await this.client.get(`/open-api/v1/domain/${vmId}/vnc-password`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      // 获取虚拟机详情（包含主机信息）
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

  /**
   * 生成VNC连接令牌
   * 用于WebSocket认证
   */
  async generateVNCToken(token, vmId) {
    try {
      const vncInfo = await this.getVNCConnection(token, vmId);
      
      // 生成包含VNC连接信息的令牌
      const jwt = require('jsonwebtoken');
      const vncToken = jwt.sign(
        {
          vmId,
          host: vncInfo.host,
          port: vncInfo.port,
          timestamp: Date.now(),
        },
        config.jwt.secret,
        {
          expiresIn: '1h', // VNC令牌1小时有效
        }
      );

      return {
        token: vncToken,
        ...vncInfo,
      };
    } catch (error) {
      throw new Error('生成VNC令牌失败: ' + error.message);
    }
  }

  // ===== 用户权限相关 =====

  /**
   * 检查用户对虚拟机的访问权限
   */
  async checkVMPermission(token, vmId) {
    try {
      // 尝试获取虚拟机详情，如果成功则有权限
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

// 创建单例实例
const ocloudviewService = new OcloudviewService();

module.exports = ocloudviewService;