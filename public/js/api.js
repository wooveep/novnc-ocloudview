// public/js/api.js - API调用和工具函数

const API_BASE = '/api';

// 工具函数
const Utils = {
  // 获取令牌
  getToken() {
    return localStorage.getItem('token') || sessionStorage.getItem('token');
  },

  // 设置令牌
  setToken(token, remember = false) {
    if (remember) {
      localStorage.setItem('token', token);
    } else {
      sessionStorage.setItem('token', token);
    }
  },

  // 清除令牌
  clearToken() {
    localStorage.removeItem('token');
    sessionStorage.removeItem('token');
    localStorage.removeItem('username');
    sessionStorage.removeItem('username');
  },

  // 获取用户名
  getUsername() {
    return localStorage.getItem('username') || sessionStorage.getItem('username');
  },

  // 设置用户名
  setUsername(username, remember = false) {
    if (remember) {
      localStorage.setItem('username', username);
    } else {
      sessionStorage.setItem('username', username);
    }
  },

  // 显示错误消息
  showError(message, duration = 5000) {
    const errorEl = document.getElementById('errorMessage');
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.classList.add('show');

      setTimeout(() => {
        errorEl.classList.remove('show');
      }, duration);
    } else {
      alert(message);
    }
  },

  // 显示成功消息
  showSuccess(message, duration = 3000) {
    // 简单使用 alert，如果需要可以添加更优雅的提示
    alert(message);
  },

  // 显示加载状态
  showLoading(message = '正在加载...') {
    const loadingOverlay = document.getElementById('loadingOverlay');
    const loadingMessage = document.getElementById('loadingMessage');
    
    if (loadingOverlay) {
      if (loadingMessage) {
        loadingMessage.textContent = message;
      }
      loadingOverlay.classList.add('show');
    }
  },

  // 隐藏加载状态
  hideLoading() {
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) {
      loadingOverlay.classList.remove('show');
    }
  },

  // 格式化时间
  formatDate(date) {
    const d = new Date(date);
    return d.toLocaleString('zh-CN');
  },

  // 获取状态文本
  getStatusText(status) {
    const statusMap = {
      'running': '运行中',
      'stopped': '已停止',
      'suspended': '已挂起',
      'paused': '已暂停',
      'shutoff': '已关机',
      'crashed': '已崩溃',
      'unknown': '未知',
    };
    return statusMap[status] || status;
  }
};

// API 调用封装
const API = {
  // 基础请求方法
  async request(url, options = {}) {
    const token = Utils.getToken();

    const defaultOptions = {
      headers: {
        'Content-Type': 'application/json',
        ...(token && { 'Authorization': `Bearer ${token}` }),
      },
    };

    const response = await fetch(`${API_BASE}${url}`, {
      ...defaultOptions,
      ...options,
      headers: {
        ...defaultOptions.headers,
        ...options.headers,
      },
    });

    // 处理401错误（未授权）
    if (response.status === 401) {
      Utils.clearToken();
      window.location.href = '/';
      throw new Error('登录已过期，请重新登录');
    }

    const result = await response.json();

    // For operations like force-reset that may return 500 but actually succeed,
    // check if result.success is true before throwing error
    if (!response.ok) {
      // If the response body indicates success despite HTTP error code, return it
      if (result.success === true) {
        console.warn(`⚠️ API returned HTTP ${response.status} but operation succeeded`);
        return result;
      }
      throw new Error(result.message || `请求失败: ${response.status}`);
    }

    return result;
  },

  // 认证相关
  auth: {
    async login(username, password) {
      return API.request('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
    },

    async logout() {
      return API.request('/auth/logout', {
        method: 'POST',
      });
    },

    async verify() {
      return API.request('/auth/verify');
    },

    async refresh() {
      return API.request('/auth/refresh', {
        method: 'POST',
      });
    },
  },

  // 虚拟机相关
  vm: {
    async list(params = {}) {
      const queryString = new URLSearchParams(params).toString();
      return API.request(`/vm/list${queryString ? `?${queryString}` : ''}`);
    },

    async get(id) {
      return API.request(`/vm/${id}`);
    },

    async start(id) {
      return API.request(`/vm/${id}/start`, {
        method: 'POST',
      });
    },

    async stop(id) {
      return API.request(`/vm/${id}/stop`, {
        method: 'POST',
      });
    },

    async restart(id) {
      return API.request(`/vm/${id}/restart`, {
        method: 'POST',
      });
    },

    async forceReset(id) {
      return API.request(`/vm/${id}/force-reset`, {
        method: 'POST',
      });
    },
  },

  // VNC相关
  vnc: {
    async connect(vmId) {
      return API.request(`/vnc/connect/${vmId}`);
    },

    async getToken(vmId) {
      return API.request(`/vnc/token/${vmId}`);
    },
  },
};

// 认证检查
async function checkAuth() {
  const token = Utils.getToken();
  if (!token) {
    window.location.href = '/';
    return false;
  }

  try {
    await API.auth.verify();
    return true;
  } catch (error) {
    Utils.clearToken();
    window.location.href = '/';
    return false;
  }
}

// 服务器状态检查
async function checkServerStatus() {
  try {
    const response = await fetch('/health');
    return response.ok;
  } catch (error) {
    return false;
  }
}

// 全局初始化
document.addEventListener('DOMContentLoaded', () => {
  // 设置AJAX全局错误处理
  window.addEventListener('unhandledrejection', event => {
    console.error('Unhandled promise rejection:', event.reason);
    Utils.showError('操作失败: ' + (event.reason?.message || '未知错误'));
  });

  // 定期刷新令牌（每10分钟）
  if (Utils.getToken()) {
    setInterval(async () => {
      try {
        await API.auth.refresh();
      } catch (error) {
        console.error('Token refresh failed:', error);
      }
    }, 10 * 60 * 1000);
  }
});