/**
 * Logger Module - 统一的日志管理
 *
 * 支持通过环境变量 DEBUG_LEVEL 控制日志输出级别
 *
 * 使用方法:
 *   const logger = require('./lib/logger');
 *   logger.debug('调试信息');
 *   logger.info('常规信息');
 *   logger.warn('警告信息');
 *   logger.error('错误信息');
 *
 * 环境变量配置:
 *   DEBUG_LEVEL=debug  - 显示所有日志 (默认)
 *   DEBUG_LEVEL=info   - 显示 info/warn/error
 *   DEBUG_LEVEL=warn   - 显示 warn/error
 *   DEBUG_LEVEL=error  - 仅显示 error
 *   DEBUG_LEVEL=none   - 不显示任何日志
 */

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  none: 4
};

class Logger {
  constructor() {
    // 从环境变量读取日志级别，默认为 debug
    const envLevel = (process.env.DEBUG_LEVEL || 'debug').toLowerCase();
    this.level = LOG_LEVELS[envLevel] !== undefined ? LOG_LEVELS[envLevel] : LOG_LEVELS.debug;

    // 如果日志级别不是 none，显示当前日志配置
    if (this.level < LOG_LEVELS.none) {
      const levelName = Object.keys(LOG_LEVELS).find(key => LOG_LEVELS[key] === this.level);
      console.log(`📋 Logger initialized with level: ${levelName.toUpperCase()}`);
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
      if (this.level < LOG_LEVELS.none) {
        console.log(`📋 Logger level changed to: ${level.toUpperCase()}`);
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

// 导出单例
module.exports = new Logger();
