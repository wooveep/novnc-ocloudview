# noVNC-ocloudview 云桌面系统

一个基于 noVNC 和 ocloudview 的轻量级 Web 远程桌面解决方案，通过浏览器即可访问虚拟机桌面。

## ✨ 特性

- 🌐 **纯Web访问** - 无需安装客户端，支持所有现代浏览器
- 🔒 **安全连接** - WebSocket 加密传输，JWT 认证机制
- 🖥️ **虚拟机管理** - 集成 ocloudview API，支持虚拟机启动、停止、重启
- 📱 **响应式设计** - 适配桌面和移动设备
- ⚡ **高性能** - WebSocket 代理优化，支持图像压缩和质量调整
- 🎨 **现代UI** - 简洁美观的用户界面

## 📋 系统要求

- Node.js >= 14.0.0
- npm >= 6.0.0
- ocloudview 系统（v9.1 或更高版本）
- Docker & Docker Compose（可选）

## 🚀 快速开始

### 方法一：直接运行

1. **克隆项目**
```bash
git clone https://github.com/your-org/novnc-ocloudview.git
cd novnc-ocloudview
```

2. **安装依赖**
```bash
npm install
```

3. **配置环境变量**
```bash
cp .env.example .env
# 编辑 .env 文件，配置 ocloudview API 地址
vim .env
```

4. **启动服务**
```bash
# 生产环境
npm start

# 开发环境（热重载）
npm run dev
```

5. **访问系统**
打开浏览器访问：http://localhost:3000

### 方法二：Docker 部署

1. **配置环境**
```bash
cp .env.example .env
vim .env  # 配置 ocloudview API 地址
```

2. **启动服务**
```bash
docker-compose up -d
```

3. **查看日志**
```bash
docker-compose logs -f
```

## 🔧 配置说明

编辑 `.env` 文件进行配置：

```env
# ocloudview API地址（必填）
OCLOUDVIEW_API_URL=http://192.168.40.161:8088

# JWT密钥（生产环境必须更改）
JWT_SECRET=your_secret_key_here

# 服务端口
PORT=3000

# 其他配置项见 .env.example
```

## 📁 项目结构

```
novnc-ocloudview/
├── server.js           # 主服务器文件（包含所有后端逻辑）
├── public/             # 前端静态文件
│   ├── index.html     # 登录页面
│   ├── dashboard.html # 虚拟机仪表板
│   ├── vnc.html       # VNC 连接页面
│   ├── css/           # 样式文件
│   │   └── main.css   # 主样式
│   └── js/            # JavaScript文件
│       └── api.js     # API调用封装
├── package.json        # 项目依赖
├── .env.example       # 环境变量示例
├── Dockerfile         # Docker镜像配置
├── docker-compose.yml # Docker Compose配置
└── README.md          # 项目文档
```

## 🔌 API 端点

### 认证接口
- `POST /api/auth/login` - 用户登录
- `POST /api/auth/logout` - 用户登出
- `POST /api/auth/refresh` - 刷新令牌
- `GET /api/auth/verify` - 验证令牌

### 虚拟机管理
- `GET /api/vm/list` - 获取虚拟机列表
- `GET /api/vm/:id` - 获取虚拟机详情
- `POST /api/vm/:id/start` - 启动虚拟机
- `POST /api/vm/:id/stop` - 停止虚拟机
- `POST /api/vm/:id/restart` - 重启虚拟机

### VNC连接
- `GET /api/vnc/connect/:vmId` - 获取VNC连接信息
- `GET /api/vnc/token/:vmId` - 生成VNC令牌

## 🔒 安全建议

### 生产环境部署

1. **更改默认密钥**
   - 必须更改 `JWT_SECRET` 为强密码
   - 使用环境变量管理敏感信息

2. **启用 HTTPS**
   ```nginx
   server {
       listen 443 ssl;
       ssl_certificate /path/to/cert.pem;
       ssl_certificate_key /path/to/key.pem;
       
       location / {
           proxy_pass http://localhost:3000;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection "upgrade";
       }
   }
   ```

3. **网络安全**
   - 配置防火墙规则
   - 限制API访问IP
   - 启用访问日志

## 🛠️ 开发指南

### 本地开发
```bash
# 安装依赖
npm install

# 开发模式（支持热重载）
npm run dev

# 运行测试
npm test
```

### 构建Docker镜像
```bash
docker build -t novnc-ocloudview .
```

## 🐛 故障排除

### 常见问题

1. **无法连接到ocloudview API**
   - 检查 `OCLOUDVIEW_API_URL` 配置
   - 验证网络连接
   - 确认API服务状态

2. **VNC连接失败**
   - 检查虚拟机VNC服务是否启动
   - 验证VNC端口是否开放
   - 查看WebSocket连接日志

3. **登录失败**
   - 确认用户名密码正确
   - 检查ocloudview API响应
   - 查看服务器日志

### 查看日志
```bash
# Docker环境
docker-compose logs -f

# 直接运行
tail -f logs/app.log
```

## 📊 性能优化

1. **WebSocket优化**
   - 调整心跳间隔
   - 启用数据压缩
   - 配置连接池

2. **VNC优化**
   - 根据网络质量调整图像质量
   - 启用图像压缩
   - 优化缓冲区大小

3. **前端优化**
   - 启用Gzip压缩
   - 使用CDN加速
   - 缓存静态资源

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

### 开发流程
1. Fork 项目
2. 创建功能分支
3. 提交更改
4. 推送到分支
5. 创建 Pull Request

## 📝 许可证

MIT License - 详见 [LICENSE](LICENSE) 文件

## 🙏 致谢

- [noVNC](https://github.com/novnc/noVNC) - Web VNC客户端
- [ocloudview](https://ocloudview.com) - 虚拟化管理平台
- [Express.js](https://expressjs.com) - Node.js Web框架

## 📧 联系方式

- Issue反馈：[GitHub Issues](https://github.com/your-org/novnc-ocloudview/issues)
- 邮箱：support@example.com

---

**注意**：本项目仍在积极开发中，生产环境使用前请充分测试。