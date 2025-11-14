# 调试日志系统使用文档

## 概述

本项目实现了统一的调试日志管理系统，支持通过环境变量或浏览器配置控制日志输出级别，可以方便地隐藏或显示调试信息。

## 功能特点

- 统一的日志接口（后端和前端）
- 多级日志控制（debug/info/warn/error/none）
- 保留原有的 emoji 风格输出
- 运行时动态调整日志级别
- 最小化代码改动

## 日志级别

日志系统支持以下级别（从低到高）：

| 级别 | 说明 | 使用场景 |
|------|------|----------|
| `debug` | 调试信息 | 开发调试、详细的协议信息、连接跟踪 |
| `info` | 一般信息 | 服务器启动、重要操作、API 响应 |
| `warn` | 警告信息 | 潜在问题、异常但不影响运行的情况 |
| `error` | 错误信息 | 错误、异常、失败的操作 |
| `none` | 不输出 | 完全关闭日志输出 |

**级别规则：** 设置某个级别后，该级别及更高级别的日志都会显示。例如设置为 `info`，则会显示 `info`、`warn`、`error`，但不显示 `debug`。

## 后端配置

### 1. 环境变量配置

在项目根目录的 `.env` 文件中配置：

```bash
# 日志配置
DEBUG_LEVEL=debug
```

### 2. 可选值

```bash
DEBUG_LEVEL=debug    # 显示所有日志（开发环境推荐）
DEBUG_LEVEL=info     # 显示 info/warn/error（生产环境推荐）
DEBUG_LEVEL=warn     # 显示 warn/error
DEBUG_LEVEL=error    # 仅显示错误
DEBUG_LEVEL=none     # 不显示任何日志
```

### 3. 使用示例

```javascript
const logger = require('./lib/logger');

// 调试信息
logger.debug('🔌 New WebSocket connection for VM', vmId);

// 一般信息
logger.info('🚀 Server started on port', port);

// 警告信息
logger.warn('⚠️ Connection timeout, retrying...');

// 错误信息
logger.error('❌ Failed to connect to VM:', error);
```

### 4. 运行时修改日志级别

```javascript
const logger = require('./lib/logger');

// 修改日志级别
logger.setLevel('info');

// 获取当前日志级别
const currentLevel = logger.getLevel();
console.log('Current log level:', currentLevel);
```

## 前端配置

### 1. 引入 logger 模块

在 HTML 文件中引入 logger.js（确保在使用 logger 的其他脚本之前引入）：

```html
<script src="/js/logger.js"></script>
<script src="/js/api.js"></script>
<script src="/spice-html5/src/spiceconn.js"></script>
<!-- 其他脚本... -->
```

### 2. 配置日志级别

#### 方法 1：在浏览器控制台中配置

```javascript
// 设置日志级别
localStorage.setItem('DEBUG_LEVEL', 'info');

// 刷新页面生效
location.reload();
```

#### 方法 2：使用便捷命令

```javascript
// 直接在控制台调用
setLogLevel('info');    // 设置为 info 级别
setLogLevel('debug');   // 设置为 debug 级别
setLogLevel('none');    // 关闭所有日志

// 查看当前级别
logger.getLevel();      // 返回当前日志级别
```

### 3. 使用示例

```javascript
// 前端代码中直接使用全局 logger 对象

// 调试信息
logger.debug('✅ [WebSocket] Connection OPENED');

// 一般信息
logger.info('📞 Connecting to VM:', vmId);

// 警告信息
logger.warn('⚠️ Connection unstable');

// 错误信息
logger.error('❌ [WebSocket] Connection ERROR', error);
```

## 典型使用场景

### 场景 1：开发环境（显示所有日志）

**后端 .env 配置：**
```bash
NODE_ENV=development
DEBUG_LEVEL=debug
```

**前端配置：**
```javascript
// 浏览器控制台
setLogLevel('debug');
```

### 场景 2：生产环境（仅显示重要信息）

**后端 .env 配置：**
```bash
NODE_ENV=production
DEBUG_LEVEL=info
```

**前端配置：**
```javascript
// 浏览器控制台
setLogLevel('info');
```

### 场景 3：调试特定问题（临时启用详细日志）

**后端（运行时修改）：**
```javascript
// 在 server.js 或其他入口文件中
const logger = require('./lib/logger');
logger.setLevel('debug');
```

**前端（浏览器控制台）：**
```javascript
setLogLevel('debug');
location.reload();  // 刷新页面
```

### 场景 4：完全关闭日志（性能优化）

**后端 .env 配置：**
```bash
DEBUG_LEVEL=none
```

**前端配置：**
```javascript
setLogLevel('none');
```

## 已替换的文件清单

### 后端文件

- `lib/logger.js` - 后端日志模块（新增）
- `server.js` - 主服务器文件
- `lib/websockify-proxy.js` - WebSocket 代理
- `lib/spice-handler.js` - SPICE 连接处理
- `lib/websocket-handler.js` - WebSocket 连接处理

### 前端文件

- `public/js/logger.js` - 前端日志模块（新增）
- `public/js/api.js` - API 调用封装
- `public/spice-html5/src/spiceconn.js` - SPICE WebSocket 连接
- `public/spice-html5/src/display.js` - SPICE 显示处理
- `public/spice-html5/src/main.js` - SPICE 主通道
- `public/spice-html5/src/playback.js` - 音频播放
- `public/spice-html5/src/wire.js` - 网络传输
- `public/spice-html5/src/quic.js` - QUIC 压缩
- `public/spice-html5/src/inputs.js` - 输入处理
- `public/spice-html5/src/cursor.js` - 鼠标光标
- `public/spice-html5/src/port.js` - 端口通道
- `public/spice-html5/src/resize.js` - 窗口调整
- `public/spice-html5/src/simulatecursor.js` - 光标模拟
- `public/spice-html5/src/spicearraybuffer.js` - ArrayBuffer 处理
- `public/spice-html5/src/ticket.js` - 认证票据
- `public/spice-html5/src/utils.js` - 工具函数
- `public/spice-html5/src/h264.js` - H264 编解码

## 常见问题

### Q1: 修改 .env 文件后日志级别没有变化？

**A:** 需要重启服务器才能使环境变量生效：
```bash
# 停止服务器（Ctrl+C）然后重新启动
npm start
```

### Q2: 前端日志设置后刷新页面又恢复默认了？

**A:** 确保使用 `localStorage.setItem('DEBUG_LEVEL', 'xxx')` 而不是 `sessionStorage`，或者使用便捷命令 `setLogLevel('xxx')`。

### Q3: 如何临时查看某个特定的调试信息？

**A:**
```javascript
// 后端：在需要查看的代码附近临时修改
logger.setLevel('debug');
// ... 你的代码 ...
logger.setLevel('info');  // 恢复原来的级别

// 前端：在浏览器控制台
setLogLevel('debug');
// 执行操作后恢复
setLogLevel('info');
```

### Q4: logger is not defined 错误？

**A:**
- **后端：** 确保在文件开头引入了 logger：`const logger = require('./lib/logger');`
- **前端：** 确保在 HTML 中先加载了 `/js/logger.js`，然后再加载使用 logger 的其他脚本

### Q5: 如何查看当前的日志级别？

**A:**
```javascript
// 后端
const logger = require('./lib/logger');
console.log('Current level:', logger.getLevel());

// 前端（浏览器控制台）
logger.getLevel();
```

## 性能考虑

- 日志级别检查非常轻量，对性能影响极小
- 在生产环境建议使用 `info` 或 `error` 级别，减少不必要的日志输出
- 使用 `none` 级别可以完全禁用日志输出，获得最佳性能

## 迁移说明

项目中所有的 `console.log`、`console.error`、`console.warn` 已被替换为相应的 logger 方法：

- `console.log(...)` → `logger.debug(...)` 或 `logger.info(...)`
- `console.error(...)` → `logger.error(...)`
- `console.warn(...)` → `logger.warn(...)`

所有的 emoji 图标和日志格式都保持不变，只是现在可以通过配置来控制它们的显示。

## 总结

通过统一的日志系统，你现在可以：

1. 在开发时查看详细的调试信息
2. 在生产环境中隐藏调试信息，仅显示重要日志
3. 按需动态调整日志级别，方便问题排查
4. 提升用户体验和系统性能

如有任何问题或建议，欢迎反馈！
