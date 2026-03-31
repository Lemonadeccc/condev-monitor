[English](./README.md) | 中文

# React + FastAPI RAG 示例中的 Condev 接入

这个目录展示了如何把 Condev 接到原版 `swxy` 项目里。

相对于原版项目，可观测相关改动被刻意收敛在少量文件里：

- 前端启动和用户上下文
- 后端 trace / span 上报
- 环境变量

## 新增了什么

### 前端

与原版 React/Vite 项目对照的文件：

- [frontend/src/main.tsx](./frontend/src/main.tsx)
- [frontend/src/App.tsx](./frontend/src/App.tsx)

前端接入主要做了三件事：

1. 用 `VITE_CONDEV_DSN` 初始化浏览器 SDK
2. 为 `/chat_on_docs` 开启 `aiStreaming`
3. 用 `setUser(...)` / `clearUser()` 把当前登录业务用户同步到 SDK

相对于原版，每个前端文件改了什么：

- `frontend/src/main.tsx`
  新增 `initCondev(...)`、replay 配置、`aiStreaming.urlPatterns` 和 `traceHeaderOrigins`
- `frontend/src/App.tsx`
  新增浏览器侧用户同步，在登录 / 退出时调用 `setUser(...)` / `clearUser()`

### 后端

与原版 FastAPI 后端对照的文件：

- [backend/app/service/observability.py](./backend/app/service/observability.py)
- [backend/app/router/chat_rt.py](./backend/app/router/chat_rt.py)
- [backend/app/service/core/chat.py](./backend/app/service/core/chat.py)
- [backend/app/app_main.py](./backend/app/app_main.py)

后端接入主要做了四件事：

1. 从 `x-condev-trace-id` 创建根 trace
2. 手动发 retrieval 和 generation spans
3. 显式记录取消和错误路径
4. 在关闭 FastAPI 时 flush Python reporter

相对于原版，每个后端文件改了什么：

- `backend/app/service/observability.py`
  新增 Python SDK 初始化、trace 工厂、span 策略元数据和 flush 帮助函数
- `backend/app/router/chat_rt.py`
  新增从 `x-condev-trace-id` 创建根 trace，并在知识检索外包一层 retrieval span
- `backend/app/service/core/chat.py`
  新增主 LLM generation span，以及后处理、取消和错误上报
- `backend/app/app_main.py`
  新增 shutdown flush，避免缓冲中的观测数据丢失

## 环境变量

### 前端

见 [frontend/.env.example](./frontend/.env.example)：

```env
VITE_API_BASE=http://localhost:8000
VITE_CONDEV_DSN=http://localhost:8082/dsn-api/tracking/<appId>
```

`VITE_API_BASE` 用来推导 `traceHeaderOrigins`，从而给跨域请求自动注入 trace 头。

### 后端

见 [backend/.env.example](./backend/.env.example)：

```env
CONDEV_SERVER_DSN=http://localhost:8082/dsn-api/tracking/<appId>
```

后端即使没有 `CONDEV_SERVER_DSN` 也能运行，只是不会上报 AI traces。

## 接入清单

给另一个 React + FastAPI 风格的 RAG 项目接入时，可按下面检查：

1. 前端增加这两个环境变量：
    - `VITE_CONDEV_DSN`
    - `VITE_API_BASE`
2. 在前端入口初始化 `@condev-monitor/monitor-sdk-browser`
3. 配置：
    - `aiStreaming.urlPatterns`
    - `aiStreaming.traceHeaderOrigins`
    - 如需要可开启 `replay`
4. 用 `setUser(...)` 把当前业务用户同步进浏览器 SDK
5. 在后端新增类似 [backend/app/service/observability.py](./backend/app/service/observability.py) 的初始化模块
6. 从请求里读取 `x-condev-trace-id`，并按每次聊天请求创建根 trace
7. 用手动 spans / generations 包住 retrieval、generation、cancel、error 这些关键路径
8. 在 FastAPI shutdown 时 flush reporter

## 验证

前后端都接好后，到 `apps/frontend/monitor` 验证这些页面：

- `AI Streaming`
- `AI Traces`
- `AI Sessions`
- `AI Users`
- `AI Cost`

如果 `AI Streaming` 有数据但 `AI Traces` 为空，最常见原因是后端 DSN 没配好，或者后端运行环境本身打不到 DSN。
