/**
 * Logger Module (Frontend) - 前端统一日志管理
 *
 * 支持通过 localStorage 或 window.DEBUG_LEVEL 控制日志输出级别
 *
 * 使用方法:
 *   <script src="/js/logger.js"></script>
 *   logger.debug('调试信息');
 *   logger.info('常规信息');
 *   logger.warn('警告信息');
 *   logger.error('错误信息');
 *
 * 配置方法:
 *   在浏览器控制台中:
 *   localStorage.setItem('DEBUG_LEVEL', 'info');  // 设置日志级别
 *   location.reload();  // 刷新页面生效
 *
 *   或者在代码中:
 *   window.DEBUG_LEVEL = 'debug';
 *
 * 日志级别:
 *   debug - 显示所有日志
 *   info  - 显示 info/warn/error
 *   warn  - 显示 warn/error
 *   error - 仅显示 error
 *   none  - 不显示任何日志 (默认)
 */

(function(window) {
  'use strict';

  const LOG_LEVELS = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
    none: 4
  };

  class Logger {
    constructor() {
      // 从 localStorage 或 window.DEBUG_LEVEL 读取日志级别，默认为 none（隐藏所有日志）
      let envLevel = 'none';

      try {
        envLevel = localStorage.getItem('DEBUG_LEVEL') || window.DEBUG_LEVEL || 'none';
      } catch (e) {
        // localStorage 可能不可用（例如在某些隐私模式下）
        envLevel = window.DEBUG_LEVEL || 'none';
      }

      envLevel = envLevel.toLowerCase();
      this.level = LOG_LEVELS[envLevel] !== undefined ? LOG_LEVELS[envLevel] : LOG_LEVELS.debug;

      // 如果日志级别不是 none，显示当前日志配置
      if (this.level < LOG_LEVELS.none) {
        const levelName = Object.keys(LOG_LEVELS).find(key => LOG_LEVELS[key] === this.level);
        console.log(`📋 [Frontend Logger] Initialized with level: ${levelName.toUpperCase()}`);
      }
    }

    /**
     * 格式化日志时间戳
     */
    getTimestamp() {
      const now = new Date();
      return now.toISOString();
    }

    /**
     * 检查是否应该输出指定级别的日志
     */
    shouldLog(level) {
      return LOG_LEVELS[level] >= this.level;
    }

    /**
     * DEBUG 级别 - 详细的调试信息
     */
    debug(...args) {
      if (this.shouldLog('debug')) {
        console.log(...args);
      }
    }

    /**
     * INFO 级别 - 一般信息
     */
    info(...args) {
      if (this.shouldLog('info')) {
        console.log(...args);
      }
    }

    /**
     * WARN 级别 - 警告信息
     */
    warn(...args) {
      if (this.shouldLog('warn')) {
        console.warn(...args);
      }
    }

    /**
     * ERROR 级别 - 错误信息
     */
    error(...args) {
      if (this.shouldLog('error')) {
        console.error(...args);
      }
    }

    /**
     * 设置日志级别（运行时修改）
     */
    setLevel(level) {
      const levelLower = level.toLowerCase();
      if (LOG_LEVELS[levelLower] !== undefined) {
        this.level = LOG_LEVELS[levelLower];

        // 保存到 localStorage
        try {
          localStorage.setItem('DEBUG_LEVEL', levelLower);
        } catch (e) {
          // localStorage 可能不可用
        }

        if (this.level < LOG_LEVELS.none) {
          console.log(`📋 [Frontend Logger] Level changed to: ${level.toUpperCase()}`);
        }
        return true;
      }
      return false;
    }

    /**
     * 获取当前日志级别
     */
    getLevel() {
      return Object.keys(LOG_LEVELS).find(key => LOG_LEVELS[key] === this.level);
    }
  }

  // 导出为全局变量
  window.logger = new Logger();

  // 提供便捷的控制台命令
  window.setLogLevel = function(level) {
    return window.logger.setLevel(level);
  };

})(window);
