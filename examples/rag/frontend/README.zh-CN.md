[English](./README.md) | 中文

# React/Vite 前端中的 Condev 接入

这个前端是给“React/Vite 前端 + 独立 AI 后端（如 FastAPI）”这种架构做浏览器侧接入的参考实现。

相对于原版前端，Condev 相关改动主要集中在：

- [src/main.tsx](./src/main.tsx)
- [src/App.tsx](./src/App.tsx)

相对于原版，每个文件改了什么：

- [src/main.tsx](./src/main.tsx)
  新增浏览器 SDK 初始化、replay 精简配置、AI streaming 配置和 trace header origins
- [src/App.tsx](./src/App.tsx)
  新增业务用户同步，在登录 / 退出时调用 `setUser(...)` / `clearUser()`

## 1. 添加环境变量

见 [.env.example](./.env.example)：

```env
VITE_API_BASE=http://localhost:8000
VITE_CONDEV_DSN=http://localhost:8082/dsn-api/tracking/<appId>
```

说明：

- `VITE_CONDEV_DSN` 用于开启浏览器错误、replay、performance 和 AI streaming 上报
- `VITE_API_BASE` 用来推导 `traceHeaderOrigins`，从而给后端请求自动注入 trace 头

## 2. 初始化浏览器 SDK

在 [src/main.tsx](./src/main.tsx) 中，只初始化一次 `@condev-monitor/monitor-sdk-browser`：

- 开启 `replay`
- 开启 `aiStreaming`
- 配置真实的 AI 请求路径
- 把后端 origin 传给 `traceHeaderOrigins`

当前示例使用的是：

```ts
initCondev({
  dsn: condevDsn,
  replay: {
    beforeErrorMs: 8000,
    afterErrorMs: 4000,
    maxEvents: 1200,
    record: {
      inlineImages: false,
      collectFonts: false,
      recordCanvas: false,
      mousemoveWait: 120,
    },
  },
  aiStreaming: {
    urlPatterns: ['/chat_on_docs'],
    traceHeaderOrigins,
  },
})
```

## 3. 同步当前登录用户

在 [src/App.tsx](./src/App.tsx) 中，把当前业务用户同步到浏览器 SDK：

- 登录后调用 `setUser(...)`
- 退出后调用 `clearUser()`

如果你的业务里只有用户名没有邮箱，至少也要传稳定的 `id`。如果用户名本身就是邮箱，可以把它同时作为 `id` 和 `email`。

## 4. 仅前端接入还不够

前端单独接入后，可以得到：

- 浏览器错误
- performance
- replay
- AI streaming

但如果你还想看到：

- `AI Traces`
- `AI Sessions`
- `AI Users`
- `AI Cost`

后端也必须读取 `x-condev-trace-id` 并上报语义 AI spans。可继续看：

- [../README.zh-CN.md](../README.zh-CN.md)
- [../backend/README.md](../backend/README.md)

## 5. 验证

前后端都接好以后，确认：

- `AI Streaming` 里有 `/chat_on_docs` 的记录
- `AI Traces` 里能看到语义 spans
- `AI Sessions` 能按 session 分组
- `AI Users` 能按业务用户分组
- `AI Cost` 能看到 model/provider 的汇总
