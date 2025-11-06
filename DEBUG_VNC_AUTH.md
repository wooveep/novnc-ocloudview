# VNC 认证失败调试指南

## 问题现象

```
Security failure: Authentication failed
Failed when connecting: Security negotiation failed on security result
```

## 问题定位步骤

### 1. 查看浏览器控制台日志

刷新页面后，在浏览器控制台应该看到：

```javascript
📊 VNC Info from API: {
  host: "x.x.x.x",
  port: 5900,
  hasPassword: true,
  passwordLength: 8,
  passwordPreview: "abc***"
}

Using password: ***xyz
✅ RFB instance created with credentials
```

**检查项**：
- ✅ `hasPassword` 应该为 `true`
- ✅ `passwordLength` 应该 > 0
- ❌ 如果显示 `NO PASSWORD`，说明 API 没有返回密码

### 2. 查看服务器端日志

服务器控制台应该显示：

```bash
📞 VNC connect request for VM: xxx
📊 VNC Info retrieved: {
  host: 'x.x.x.x',
  port: 5900,
  hasPassword: true,
  passwordLength: 8,
  passwordPreview: 'abc***'
}
```

**检查项**：
- ✅ 确认服务器成功获取到密码
- ❌ 如果 `hasPassword: false`，说明 OcloudView API 没有返回密码

### 3. 测试密码是否正确

#### 方法 1：使用 VNC 客户端测试

```bash
# 安装 vnc 客户端
apt-get install tigervnc-viewer

# 连接测试
vncviewer <host>:<port>
# 输入密码测试
```

#### 方法 2：检查 VNC 服务器配置

```bash
# 登录到 VNC 服务器主机
virsh domdisplay <vm-name>
# 或
virsh vncdisplay <vm-name>
```

### 4. 常见问题和解决方案

#### 问题 A：密码未设置

**现象**：
- 浏览器：`NO PASSWORD`
- 服务器：`hasPassword: false`

**解决**：
```bash
# 在 OcloudView 平台设置 VNC 密码
# 或者直接在虚拟机 XML 配置中设置密码
```

#### 问题 B：密码格式错误

**现象**：
- 有密码，但认证失败
- VNC 服务器期望明文，但收到了 Base64

**检查**：
```javascript
// server.js line 325
password: data.data.password,          // Base64 编码
decodedPassword: decodePassword(data.data.password),  // 解码后
```

**解决**：确认 API 返回的是 `decodedPassword`

#### 问题 C：VNC 服务器不需要密码

**现象**：
- VNC 服务器配置为无密码
- noVNC 客户端发送了密码导致认证失败

**解决**：
```javascript
// vnc.html - 修改为空密码
credentials: {
    password: '',  // 强制使用空密码
}
```

#### 问题 D：密码编码问题

VNC 协议使用 DES 加密密码，noVNC 会自动处理。但如果：
- 密码包含特殊字符
- 密码长度 > 8 字符

可能导致问题。

**检查密码**：
```bash
# 在服务器端打印完整密码（仅用于调试）
console.log('Full password:', vncInfo.password);
```

### 5. 使用测试工具

创建测试脚本 `test-vnc-auth.js`：

```javascript
const net = require('net');

const host = 'x.x.x.x';
const port = 5900;
const password = 'your-password';

const client = net.connect(port, host, () => {
  console.log('✅ TCP connected to VNC server');
});

client.on('data', (data) => {
  console.log('📥 Received:', data.length, 'bytes');
  console.log('   Hex:', data.toString('hex').substring(0, 100));

  // RFB Protocol Version
  if (data.toString().startsWith('RFB')) {
    console.log('✅ VNC server version:', data.toString().trim());
    // 响应版本
    client.write('RFB 003.008\\n');
  }
});

client.on('error', (err) => {
  console.error('❌ Connection error:', err.message);
});

client.on('close', () => {
  console.log('🔌 Connection closed');
});
```

### 6. 检查 WebSocket 数据流

在浏览器控制台：

```javascript
// 创建 WebSocket 并监听数据
const ws = new WebSocket('ws://localhost:3000/vnc/{vmId}?token={token}');

ws.binaryType = 'arraybuffer';

ws.onmessage = (event) => {
  const data = new Uint8Array(event.data);
  console.log('📥 VNC data:', data.length, 'bytes');
  console.log('   First 20 bytes:', Array.from(data.slice(0, 20)));

  // 检查是否是 RFB 协议
  const text = String.fromCharCode(...data.slice(0, 12));
  if (text.startsWith('RFB')) {
    console.log('✅ RFB version:', text.trim());
  }
};
```

### 7. 调试 noVNC 内部

```javascript
// 在浏览器控制台启用 noVNC 调试日志
window.localStorage.setItem('novnc_logging', 'debug');

// 刷新页面后会看到详细的 RFB 协议日志
```

## 快速诊断命令

```bash
# 1. 启动服务器（查看日志）
node server.js

# 2. 在浏览器访问
http://localhost:3000/vnc.html?id={vmId}&token={token}

# 3. 查看浏览器控制台
# 搜索关键词：
# - "VNC Info from API"
# - "Using password"
# - "Security failure"

# 4. 查看服务器日志
# 搜索关键词：
# - "VNC Info retrieved"
# - "hasPassword"
# - "Authentication"
```

## 临时解决方案

### 方案 1：禁用 VNC 密码（不推荐）

在虚拟机 XML 配置中：
```xml
<graphics type='vnc' port='5900' autoport='yes' listen='0.0.0.0'>
  <!-- 移除 passwd 属性 -->
</graphics>
```

### 方案 2：使用固定密码测试

```javascript
// vnc.html - 临时硬编码密码测试
credentials: {
    password: 'test1234',  // 替换为实际密码
}
```

### 方案 3：跳过 WebSocket 代理直接测试

```javascript
// 直接连接到 VNC 服务器（需要 CORS 支持）
const wsUrl = 'ws://vnc-host:5900';
```

## 预期正常流程

1. ✅ 前端调用 `/api/vnc/connect/:vmId`
2. ✅ 服务器获取密码并 Base64 解码
3. ✅ 返回解码后的密码给前端
4. ✅ noVNC 使用密码创建 RFB 连接
5. ✅ RFB 协议自动 DES 加密密码
6. ✅ 发送加密密码到 VNC 服务器
7. ✅ VNC 服务器验证密码
8. ✅ 认证成功，显示桌面

## 需要收集的信息

如果问题持续，请提供：

1. **浏览器控制台完整日志**（包含密码长度信息）
2. **服务器端日志**（包含 API 请求和响应）
3. **VNC 服务器版本**（RFB 003.008 等）
4. **虚拟机平台**（KVM、QEMU、VMware 等）
5. **密码设置方式**（手动设置、自动生成等）

## 参考链接

- [noVNC 文档](https://github.com/novnc/noVNC)
- [RFB 协议规范](https://github.com/rfbproto/rfbproto/blob/master/rfbproto.rst)
- [VNC 认证流程](https://github.com/rfbproto/rfbproto/blob/master/rfbproto.rst#security-types)
