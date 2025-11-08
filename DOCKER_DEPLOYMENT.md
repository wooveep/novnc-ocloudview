# Docker 部署指南

## 快速开始

### 1. 准备环境变量

创建 `.env` 文件：

```bash
cat > .env << 'EOF'
NODE_ENV=production
PORT=3000
OCLOUDVIEW_API_URL=http://your-ocloudview-server:8088
JWT_SECRET=change-this-to-a-secure-random-string
JWT_EXPIRES_IN=24h
WEBSOCKET_PATH=/vnc
CORS_ORIGIN=*
EOF
```

### 2. 使用 Docker Compose 部署

```bash
# 构建并启动
docker-compose up -d

# 查看日志
docker-compose logs -f

# 停止服务
docker-compose down
```

### 3. 使用 Docker 命令部署

```bash
# 构建镜像
docker build -t novnc-ocloudview .

# 运行容器
docker run -d \
  --name novnc-ocloudview \
  -p 3000:3000 \
  --env-file .env \
  novnc-ocloudview

# 查看日志
docker logs -f novnc-ocloudview

# 停止容器
docker stop novnc-ocloudview
docker rm novnc-ocloudview
```

## 端口映射

默认端口是 3000，如果要使用其他端口（例如 8099）：

```bash
# Docker Compose: 修改 .env 文件
PORT=8099

# Docker 命令: 修改端口映射
docker run -p 8099:3000 ...
```

## 常见问题解决

### 问题 1: CSS/JS 文件加载失败 - ERR_SSL_PROTOCOL_ERROR

**原因**: 浏览器缓存了之前的 HTTPS 访问记录，或者 HSTS 设置导致浏览器强制使用 HTTPS

**解决方法**:

1. **清除浏览器缓存和站点数据**:
   - Chrome/Edge: 按 F12 打开开发者工具 → Application → Clear storage → Clear site data
   - 或者在地址栏输入: `chrome://settings/clearBrowserData`
   - 选择"缓存的图片和文件"和"Cookie 及其他网站数据"

2. **清除 HSTS 设置**:
   - Chrome: 访问 `chrome://net-internals/#hsts`
   - 在 "Delete domain security policies" 输入您的域名/IP
   - 点击 Delete

3. **使用隐私/无痕模式测试**:
   - 按 Ctrl+Shift+N (Chrome/Edge) 或 Ctrl+Shift+P (Firefox)
   - 在无痕窗口中访问应用

4. **强制刷新**:
   - 按 Ctrl+Shift+R (Windows) 或 Cmd+Shift+R (Mac)

### 问题 2: Origin-Agent-Cluster 警告

这是浏览器的一个警告，不影响功能。已在最新版本中禁用此头。

### 问题 3: Health Check 失败 (404)

确保使用的是正确的 health check 端点：
- ✅ 正确: `http://localhost:3000/health`
- ❌ 错误: `http://localhost:3000/api/health`

### 问题 4: 页面可以访问但资源加载失败

**检查步骤**:

1. 查看 Docker 容器日志:
```bash
docker logs novnc-ocloudview
# 或
docker-compose logs -f
```

2. 检查容器内的文件:
```bash
docker exec -it novnc-ocloudview ls -la /app/public/
docker exec -it novnc-ocloudview ls -la /app/public/css/
docker exec -it novnc-ocloudview ls -la /app/public/js/
```

3. 测试从容器内访问:
```bash
docker exec -it novnc-ocloudview wget -O- http://localhost:3000/css/main.css
```

## 重新构建和部署

当代码更新后，需要重新构建：

```bash
# 停止并删除旧容器
docker-compose down
# 或
docker stop novnc-ocloudview && docker rm novnc-ocloudview

# 重新构建（不使用缓存）
docker-compose build --no-cache

# 启动
docker-compose up -d
```

## 健康检查

访问以下端点检查服务状态：

```bash
curl http://localhost:3000/health
```

期望响应：
```json
{
  "status": "ok",
  "timestamp": "2025-11-08T01:30:00.000Z",
  "service": "novnc-ocloudview",
  "version": "1.0.0"
}
```

## 生产环境建议

### 1. 使用 HTTPS (推荐)

在生产环境中，建议使用 Nginx 作为反向代理并启用 HTTPS：

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 2. 环境变量安全

- 不要在代码中硬编码密钥
- 使用强随机字符串作为 JWT_SECRET
- 限制 CORS_ORIGIN 到特定域名

### 3. 资源限制

在 docker-compose.yml 中添加资源限制：

```yaml
services:
  novnc-ocloudview:
    # ... 其他配置
    deploy:
      resources:
        limits:
          cpus: '1.0'
          memory: 512M
        reservations:
          cpus: '0.5'
          memory: 256M
```

## 日志查看

```bash
# 实时查看日志
docker-compose logs -f

# 查看最后 100 行
docker-compose logs --tail=100

# 仅查看特定服务
docker-compose logs -f novnc-ocloudview
```

## 故障排除命令

```bash
# 进入容器
docker exec -it novnc-ocloudview sh

# 检查网络连接
docker exec -it novnc-ocloudview wget -O- http://localhost:3000/health

# 查看容器状态
docker ps -a

# 查看容器详细信息
docker inspect novnc-ocloudview
```
