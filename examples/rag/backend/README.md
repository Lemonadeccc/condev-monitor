# 智能文档问答系统 (GSK POC)

一个基于RAG（检索增强生成）技术的智能文档问答系统，支持多种文档格式的解析和问答。

## 🚀 快速启动

### 环境要求

- Docker 和 Docker Compose
- 至少 4GB 可用内存
- 10GB 可用磁盘空间

### 启动步骤

1. **克隆项目并进入目录**

```bash
cd swxy-p1
```

2. **.env 配置文件**

```bash
DASHSCOPE_API_KEY="your-api-key"
CONDEV_SERVER_DSN="http://localhost:8082/dsn-api/tracking/<appId>"
```

3. **修改docker-compose.yml中的nltk本地路径**

```bash

# 修改为你的nltk_data路径
- /your/path/to/nltk_data:/usr/local/nltk_data

```

4. **启动所有服务**

```bash
# 启动所有服务（首次启动会自动构建镜像）
docker compose up -d --build

# 查看服务状态
docker compose ps

# 查看日志
docker compose logs -f swxy_api
```

4. **等待服务完全启动**

```bash
# 检查服务健康状态
curl http://localhost:8000/docs
```

### 服务说明

项目包含以下服务：

- **swxy_api**: 主应用服务 (端口: 8000)
- **gsk_pg**: PostgreSQL数据库
- **es01**: Elasticsearch搜索引擎
- **redis**: Redis缓存

### 停止服务

```bash
# 停止所有服务
docker compose down

# 停止并删除数据卷（注意：这会删除所有数据）
docker compose down -v
```

## 🔧 开发调试

### 查看日志

```bash
# 查看所有服务日志
docker compose logs

# 查看特定服务日志
docker compose logs swxy_api
docker compose logs gsk_pg
docker compose logs es01
docker compose logs redis

# 实时跟踪日志
docker compose logs -f swxy_api
```

### 进入容器调试

```bash
# 进入主应用容器
docker compose exec swxy_api bash

# 进入数据库容器
docker compose exec gsk_pg psql -U postgres -d gsk
```

### 重新构建服务

```bash
# 重新构建并启动
docker compose up --build -d

# 仅重新构建特定服务
docker compose build swxy_api
docker compose up -d swxy_api
```

## 📋 常见问题

1. **端口被占用**: 确保8000端口未被其他程序占用
2. **内存不足**: Elasticsearch需要至少1GB内存，建议系统有4GB+可用内存
3. **首次启动慢**: 首次启动需要下载镜像和初始化数据，请耐心等待
4. **服务连接失败**: 等待所有服务完全启动后再测试API

## 🎯 访问地址

- API文档: http://localhost:8000/docs

## 📡 Condev 监控

后端现在支持通过 `CONDEV_SERVER_DSN` 上报：

- AI traces
- AI sessions
- AI users
- AI cost
- retrieval / llm / error / cancelled spans

如果没有配置 `CONDEV_SERVER_DSN`，业务逻辑仍可正常运行，只是不会上报 AI observability 数据。

## Condev Integration Checklist

Compared with the original `swxy` backend, the Condev-specific integration is mainly in:

- [app/service/observability.py](./app/service/observability.py)
- [app/router/chat_rt.py](./app/router/chat_rt.py)
- [app/service/core/chat.py](./app/service/core/chat.py)
- [app/app_main.py](./app/app_main.py)

What changed in each file:

- [app/service/observability.py](./app/service/observability.py)
  Added Python SDK bootstrap, trace creation, span policy helpers, and flush support.
- [app/router/chat_rt.py](./app/router/chat_rt.py)
  Added `x-condev-trace-id` handling and retrieval span creation in the chat route.
- [app/service/core/chat.py](./app/service/core/chat.py)
  Added the main generation span plus explicit cancellation/error reporting.
- [app/app_main.py](./app/app_main.py)
  Added reporter flushing during FastAPI shutdown.

Use this backend checklist when adding Condev to another FastAPI RAG service:

1. Add `CONDEV_SERVER_DSN` to `.env`
2. Create a small observability helper module that:
    - bootstraps the Python SDK
    - starts traces
    - defines span policy metadata
    - flushes on shutdown
3. In the chat route:
    - read `x-condev-trace-id`
    - create a root trace
    - create a retrieval span
4. In the LLM generation layer:
    - emit the main generation span
    - emit post-processing spans if needed
    - mark cancellations and errors explicitly
5. On application shutdown:
    - flush and close the Python reporter

If browser `AI Streaming` data appears but backend `AI Traces` does not, check whether `CONDEV_SERVER_DSN` is reachable from the backend runtime itself.
