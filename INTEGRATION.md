# noVNC 与 websockify-js 集成说明

## 概述

本项目已成功集成 noVNC 客户端和基于 websockify-js 架构的 WebSocket 代理，实现了浏览器到 VNC 服务器的完整连接链路。

## 集成架构

```
浏览器客户端 (noVNC)
    ↓ WebSocket
Node.js 服务器 (WebsockifyProxy)
    ↓ TCP Socket
VNC 服务器 (OcloudView 平台)
```

## 核心组件

### 1. noVNC 客户端集成

#### 本地化部署
- **位置**: `public/novnc/`
- **核心库**: `public/novnc/core/` (来自 noVNC GitHub v1.5.0 源码)
- **依赖库**: `public/novnc/vendor/` (pako 压缩库)
- **配置文件**:
  - `public/novnc/defaults.json` - 默认配置
  - `public/novnc/mandatory.json` - 强制配置

#### ⚠️ 重要说明：ES6 模块 vs CommonJS

**问题**：
npm 包 `@novnc/novnc` 包含的是经过 Babel 转译的 CommonJS 模块，不能直接在浏览器中作为 ES6 模块使用。

**错误示例**：
```
Uncaught SyntaxError: The requested module '/novnc/core/rfb.js'
does not provide an export named 'default'
```

**解决方案**：
使用 noVNC GitHub 仓库的原始 ES6 源码（未转译版本）：

```bash
# 从 GitHub 获取 ES6 源码
git clone --depth 1 --branch v1.5.0 https://github.com/novnc/noVNC.git
cp -r noVNC/core public/novnc/
cp -r noVNC/vendor public/novnc/
```

**区别对比**：

| 特性 | npm 包 | GitHub 源码 |
|------|--------|-------------|
| 模块格式 | CommonJS (Babel转译) | ES6 原生模块 |
| 导出方式 | `exports["default"]` | `export default` |
| 浏览器兼容 | ❌ 需要打包工具 | ✅ 原生支持 |
| import 语法 | ❌ 不支持 | ✅ 完全支持 |
| 文件大小 | 更大（包含polyfill） | 更小（原生代码） |

#### 前端页面更新
- **文件**: `public/vnc.html`
- **变更**:
  ```javascript
  // 之前: 从 CDN 加载
  import RFB from 'https://cdn.jsdelivr.net/npm/@novnc/novnc@latest/core/rfb.js';

  // 现在: 从本地加载
  import RFB from '/novnc/core/rfb.js';
  ```

### 2. WebsockifyProxy 代理层

#### 核心模块
**文件**: `lib/websockify-proxy.js`

**特性**:
- ✅ 基于 websockify-js 的架构设计和设计原则
- ✅ WebSocket 到 TCP 的双向数据转发
- ✅ 支持多个并发 VNC 连接（动态目标）
- ✅ 心跳机制检测死连接
- ✅ 完整的连接生命周期管理
- ✅ 错误处理和优雅关闭
- ✅ 连接统计和监控

**主要方法**:
```javascript
class WebsockifyProxy {
  constructor(options)           // 初始化代理
  handleConnection(ws, info)     // 处理新连接
  createTargetConnection(h, p)   // 创建 TCP 连接
  setupProxy(ws, target, vmId)   // 设置双向代理
  shutdown()                     // 优雅关闭
  getStats()                     // 获取统计信息
}
```

#### 连接处理器
**文件**: `lib/websocket-handler.js`

**功能**:
- Token 提取和验证
- VNC 连接信息获取
- 与 OcloudView API 集成
- 认证和授权处理

### 3. 服务器集成

#### server.js 重构
**主要变更**:

1. **导入新模块**:
```javascript
const WebsockifyProxy = require('./lib/websockify-proxy');
const { handleVNCConnection } = require('./lib/websocket-handler');
```

2. **初始化 WebsockifyProxy**:
```javascript
const wsProxy = new WebsockifyProxy({
  wss,
  heartbeatTimeout: config.websocket.heartbeat.interval,
  connectionTimeout: config.vnc.connectionTimeout,
  maxConnections: 100
});
```

3. **WebSocket 连接处理**:
```javascript
wss.on('connection', (ws, req) => {
  handleVNCConnection(ws, req, {
    wsProxy,
    config,
    ocloudviewService,
    sessionStore
  });
});
```

4. **优雅关闭**:
```javascript
const gracefulShutdown = async (signal) => {
  await wsProxy.shutdown();  // 关闭所有连接
  // ... 其他清理操作
};
```

## 技术特点

### 1. 遵循 websockify-js 设计原则

- **透明代理**: WebSocket 数据原样转发到 TCP，反之亦然
- **二进制协议支持**: 完整支持 VNC 的二进制 RFB 协议
- **最小延迟**: 直接内存拷贝，无额外处理
- **连接独立性**: 每个 VM 连接完全独立

### 2. 增强功能

相比原始 websockify-js，新实现增加了：

- **动态目标路由**: 根据 vmId 连接到不同的 VNC 服务器
- **认证集成**: JWT token 验证和会话管理
- **连接池管理**: 统一管理所有活动连接
- **监控和统计**: 实时连接状态和性能指标
- **优雅降级**: 错误恢复和连接清理

### 3. noVNC 配置

#### defaults.json 配置项
```json
{
  "autoconnect": false,      // 自动连接
  "reconnect": true,         // 断线重连
  "reconnect_delay": 5000,   // 重连延迟(ms)
  "shared": true,            // 共享模式
  "bell": true,              // 键盘响铃
  "view_only": false,        // 只读模式
  "view_clip": false,        // 裁剪视图
  "resize": "scale",         // 缩放模式: off/scale/remote
  "quality": 6,              // JPEG质量: 0-9
  "compression": 2,          // 压缩级别: 0-9
  "logging": "warn"          // 日志级别: error/warn/info/debug
}
```

## 连接流程

### 完整连接流程

1. **用户认证**
   - 用户登录获取 JWT token
   - Token 包含 sessionId 或 ocloudToken

2. **获取 VNC 信息**
   ```
   GET /api/vnc/connect/:vmId
   → 返回 VNC 连接信息 (host, port, password)
   ```

3. **建立 WebSocket 连接**
   ```
   ws://localhost:3000/vnc/{vmId}?token={jwt_token}
   ```

4. **代理处理流程**
   ```
   a. 提取并验证 token
   b. 获取 VNC 服务器信息 (host, port)
   c. 创建到 VNC 服务器的 TCP 连接
   d. 建立 WebSocket ↔ TCP 双向代理
   e. 开始数据转发
   ```

5. **VNC 协议通信**
   ```
   noVNC RFB ←→ WebSocket ←→ WebsockifyProxy ←→ TCP ←→ VNC Server
   ```

## 依赖项

### 新增依赖

```json
{
  "@novnc/novnc": "^1.4.0",           // noVNC 核心库
  "@maximegris/node-websockify": "*"  // websockify 参考实现
}
```

### 现有依赖（保留）
- `ws`: WebSocket 服务器
- `express`: Web 框架
- `net`: TCP socket 支持
- `jsonwebtoken`: JWT 认证

## 目录结构

```
novnc-ocloudview/
├── lib/
│   ├── websockify-proxy.js       # WebSocket到TCP代理 (新)
│   └── websocket-handler.js      # WebSocket连接处理器 (新)
├── public/
│   ├── novnc/
│   │   ├── core/                 # noVNC核心库 (新)
│   │   ├── defaults.json         # noVNC默认配置 (新)
│   │   └── mandatory.json        # noVNC强制配置 (新)
│   └── vnc.html                  # VNC客户端页面 (更新)
├── server.js                      # 主服务器 (重构)
└── package.json                   # 依赖配置 (更新)
```

## 性能特性

### 1. 连接管理
- **最大并发连接**: 100 (可配置)
- **心跳间隔**: 30秒
- **连接超时**: 10秒
- **优雅关闭超时**: 10秒

### 2. 数据转发
- **零拷贝转发**: 直接 Buffer 传递
- **二进制模式**: WebSocket binary frame
- **无数据缓冲**: 实时转发，无额外延迟

### 3. 资源清理
- 自动检测死连接
- 及时释放 socket 资源
- 内存泄漏防护

## 测试验证

### 启动服务器
```bash
npm start
# 或开发模式
npm run dev
```

### 预期输出
```
💓 Heartbeat mechanism started
🚀 WebsockifyProxy initialized
🔌 WebsockifyProxy initialized (based on websockify-js architecture)
🚀 noVNC-ocloudview Server Started
📡 HTTP Server: http://localhost:3000
🔌 WebSocket Server: ws://localhost:3000/vnc
```

### 健康检查
```bash
curl http://localhost:3000/health
```

预期响应:
```json
{
  "status": "ok",
  "timestamp": "2025-11-06T01:52:27.361Z",
  "service": "novnc-ocloudview",
  "version": "1.0.0"
}
```

## 与原始 websockify-js 的区别

### 相同点
- ✅ WebSocket 到 TCP 的桥接架构
- ✅ 二进制协议透明转发
- ✅ RFB 协议完整支持
- ✅ 连接生命周期管理
- ✅ 错误处理机制

### 增强点
| 特性 | 原始 websockify-js | 本实现 |
|------|-------------------|---------|
| 目标服务器 | 单一静态目标 | 多目标动态路由 |
| 认证机制 | 无 | JWT token 验证 |
| 连接管理 | 基础连接跟踪 | 完整连接池管理 |
| 监控统计 | 无 | 实时连接统计 |
| 与 Express 集成 | 需要自行实现 | 原生集成 |
| 会话管理 | 无 | 与 OcloudView 集成 |

## 安全考虑

1. **Token 认证**: 所有 WebSocket 连接需要有效 JWT token
2. **连接隔离**: 每个 VM 连接完全独立
3. **超时保护**: 防止资源耗尽
4. **错误隔离**: 单个连接错误不影响其他连接
5. **优雅关闭**: 确保资源正确释放

## 故障排查

### WebSocket 连接失败
- 检查 token 是否有效
- 验证 VNC 服务器 host:port 可达
- 查看服务器日志中的错误信息

### noVNC 加载失败
- 确认 `/novnc/core/rfb.js` 可访问
- 检查浏览器控制台错误
- 验证静态文件服务配置

### 连接断开
- 查看心跳日志
- 检查网络稳定性
- 验证 VNC 服务器状态

## 未来优化

1. **性能优化**
   - 连接复用和池化
   - 数据压缩优化
   - 更智能的心跳策略

2. **功能增强**
   - 连接重试机制
   - 更详细的监控指标
   - WebSocket 协议升级 (subprotocols)

3. **安全加固**
   - TLS/WSS 支持
   - 更严格的 token 验证
   - 连接速率限制

## 参考资源

- [noVNC 官方文档](https://github.com/novnc/noVNC)
- [websockify-js GitHub](https://github.com/novnc/websockify-js)
- [RFB 协议规范](https://github.com/rfbproto/rfbproto)
- [WebSocket RFC 6455](https://tools.ietf.org/html/rfc6455)

## 贡献者

本集成由 Claude AI 助手完成，遵循 websockify-js 的设计原则和最佳实践。

## 许可

MIT License
