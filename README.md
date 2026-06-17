# Hot Sites Sync Server

团队热门网站同步服务器，用于 Tab Mission Control Chrome 扩展。

## 📋 功能特性

- **数据收集**: 接收来自 Chrome 扩展的访问数据上报
- **团队聚合**: 聚合所有用户的访问数据，生成团队热门网站排行榜
- **RESTful API**: 提供简洁的 HTTP 接口
- **Docker 支持**: 一键部署，支持远程访问
- **CORS 支持**: 允许跨域请求，方便扩展调用

## 🚀 快速开始

### 方式一：Docker 部署（推荐）

#### 1. 构建 Docker 镜像

```bash
docker build -t hot-sites-server .
```

#### 2. 运行容器

**本地测试:**
```bash
docker run -d \
  --name hot-sites-server \
  -p 3000:3000 \
  hot-sites-server
```

**生产环境（支持远程访问）:**
```bash
docker run -d \
  --name hot-sites-server \
  -p 3000:3000 \
  -e PORT=3000 \
  --restart unless-stopped \
  hot-sites-server
```

#### 3. 验证服务

```bash
curl http://localhost:3000/health
```

预期响应:
```json
{
  "status": "ok",
  "timestamp": "2026-06-17T10:30:00.000Z",
  "recordsCount": 0
}
```

### 方式二：直接运行（需要 Node.js）

#### 1. 安装依赖

```bash
npm install
```

#### 2. 启动服务器

```bash
npm start
```

或使用开发模式（自动重启）:
```bash
npm run dev
```

## 🌐 远程访问配置

### 云服务器部署

#### 使用 Docker Compose（推荐）

创建 `docker-compose.yml`:

```yaml
version: '3.8'

services:
  hot-sites-server:
    build: .
    container_name: hot-sites-server
    ports:
      - "3000:3000"
    environment:
      - PORT=3000
    restart: unless-stopped
    volumes:
      - ./data:/app/data  # 如果需要持久化存储
```

启动服务:
```bash
docker-compose up -d
```

#### 防火墙配置

确保服务器防火墙开放 3000 端口:

**Ubuntu/Debian (UFW):**
```bash
sudo ufw allow 3000/tcp
sudo ufw reload
```

**CentOS/RHEL (firewalld):**
```bash
sudo firewall-cmd --permanent --add-port=3000/tcp
sudo firewall-cmd --reload
```

**AWS EC2:**
在安全组中添加入站规则，允许 TCP 3000 端口

#### 使用 Nginx 反向代理（可选，推荐用于生产环境）

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## 📡 API 接口

### POST `/api/visits`

接收扩展上报的访问数据。

**请求示例:**
```bash
curl -X POST http://your-server-ip:3000/api/visits \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user-lz0abc123-def",
    "syncedAt": "2026-06-17T10:30:00.000Z",
    "visits": {
      "github.com": {
        "count": 42,
        "lastVisit": "2026-06-17T10:25:00.000Z",
        "dailyCounts": {
          "2026-06-17": 5,
          "2026-06-16": 8
        }
      }
    }
  }'
```

**响应:**
```json
{ "ok": true }
```

### GET `/api/hot`

获取团队热门网站排行榜。

**请求示例:**
```bash
curl http://your-server-ip:3000/api/hot?days=30
```

**响应:**
```json
{
  "sites": [
    {
      "domain": "google.com",
      "totalVisits": 320,
      "uniqueUsers": 5,
      "lastVisit": "2026-06-17T10:00:00.000Z"
    },
    {
      "domain": "github.com",
      "totalVisits": 185,
      "uniqueUsers": 3,
      "lastVisit": "2026-06-17T10:25:00.000Z"
    }
  ]
}
```

### GET `/health`

健康检查端点。

**响应:**
```json
{
  "status": "ok",
  "timestamp": "2026-06-17T10:30:00.000Z",
  "recordsCount": 150
}
```

## 🔧 Chrome 扩展配置

在扩展的 Hot Sites 配置面板中设置服务器地址:

1. 打开扩展 popup
2. 点击 Hot Sites 配置按钮 ⚙️
3. 输入服务器地址，例如:
   - 本地测试: `http://localhost:3000`
   - 远程服务器: `http://your-server-ip:3000`
   - 域名访问: `https://your-domain.com`
4. 设置同步间隔（默认 30 分钟）
5. 点击 Save 保存

## 📊 数据存储

当前版本使用内存存储（Map），适合小规模团队测试。

**生产环境建议:**
- 使用 Redis 进行缓存和实时数据存储
- 使用 PostgreSQL/MySQL 进行持久化存储
- 添加数据过期清理机制（保留最近 90 天数据）

## 🔒 安全建议

生产环境部署时:

1. **启用 HTTPS**: 使用 Let's Encrypt 或其他 SSL 证书
2. **添加认证**: 实现 API Key 或 JWT 认证
3. **速率限制**: 防止滥用（如使用 express-rate-limit）
4. **数据备份**: 定期备份数据库
5. **监控日志**: 记录访问日志和错误日志

## 🛠️ 环境变量

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| PORT | 3000 | 服务器监听端口 |
| NODE_ENV | production | 运行环境 |

## 📝 日志

服务器会输出以下日志:

```
Hot Sites sync server running on port 3000
Health check: http://localhost:3000/health
[POST /api/visits] Received data from user user-xxx, 5 domains
[GET /api/hot] Returning 12 hot sites (last 30 days)
```

查看 Docker 容器日志:
```bash
docker logs -f hot-sites-server
```

## 🔄 更新与重启

```bash
# 停止并删除旧容器
docker stop hot-sites-server
docker rm hot-sites-server

# 重新构建镜像
docker build -t hot-sites-server .

# 启动新容器
docker run -d --name hot-sites-server -p 3000:3000 hot-sites-server
```

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 许可证

MIT License
