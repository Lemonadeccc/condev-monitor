[English](./CONTRIBUTING.md) | 中文

# Condev Monitor 贡献与 PR 开发指南

这份文档聚焦本地开发流程、仓库校验、提交规范，以及 PR 应该怎么准备。

## 目录

- [前置要求](#前置要求)
- [本地初始化](#本地初始化)
- [如何运行仓库](#如何运行仓库)
- [质量检查](#质量检查)
- [Git Hook 与提交规范](#git-hook-与提交规范)
- [Pull Request 检查清单](#pull-request-检查清单)

---

## 前置要求

- Node.js `22.15+`
- pnpm `10.10.0`
- Docker + Docker Compose

---

## 本地初始化

### 1. 安装依赖

```bash
pnpm install
```

### 2. 准备环境变量

```bash
cp apps/backend/monitor/.env.example apps/backend/monitor/.env
cp apps/backend/dsn-server/.env.example apps/backend/dsn-server/.env
```

如果你的改动涉及部署 compose 或基础设施，也建议准备：

```bash
cp .devcontainer/.env.example .devcontainer/.env
```

### 3. 启动本地数据库

```bash
pnpm docker:start
pnpm docker:init-clickhouse
```

这一步只会启动本地 ClickHouse 和 Postgres。

---

## 如何运行仓库

### 启动两个后端

```bash
pnpm start:dev
```

这个命令会通过 Turbo 跑工作区里的 `start:dev`，当前会启动：

- `apps/backend/monitor`
- `apps/backend/dsn-server`

### 启动控制台

```bash
pnpm start:fro
```

如果你的后端不在默认端口：

```bash
API_PROXY_TARGET=http://127.0.0.1:8081 \
DSN_API_PROXY_TARGET=http://127.0.0.1:8082 \
pnpm start:fro
```

### 只跑某个 package / app

```bash
pnpm --filter monitor start:dev
pnpm --filter dsn-server start:dev
pnpm --filter @condev-monitor/monitor-client dev
pnpm --filter vanilla dev
pnpm --filter aisdk-rag-chatbox dev
```

当你需要快速做 SDK 手工验证时，优先用 `examples/vanilla`，它覆盖：

- JS 错误采集
- 白屏检测
- 性能信号
- Replay 采集
- Sourcemap 上传
- Transport 批量发送 / 重试行为

---

## 质量检查

### 仓库级检查

```bash
pnpm lint
pnpm format:check
pnpm spellcheck
```

说明：

- `pnpm lint` 会带 `--fix`
- `pnpm format:check` 是只检查、不写文件
- 仓库里还有 `pnpm check`，但它会执行 `pnpm format`，也就是会改文件。适合想自动修复时用，不适合当只读校验门禁

### 后端测试

```bash
pnpm --filter monitor test
pnpm --filter monitor test:e2e
pnpm --filter dsn-server test
pnpm --filter dsn-server test:e2e
```

### 前端校验

控制台当前主要依赖 build 成功作为校验：

```bash
pnpm --filter @condev-monitor/monitor-client build
```

### 提交 PR 前至少跑什么

按改动范围至少跑对应的子集：

- 改后端 -> lint + 受影响后端测试
- 改前端 -> lint + 前端 build
- 改 SDK -> lint + package build + `examples/vanilla` 手工验证
- 纯文档 -> 至少确认 markdown 内容和拼写没有明显问题

---

## Git Hook 与提交规范

### pre-commit hook

仓库里的 Husky pre-commit hook 在 `.husky/pre-commit`，实际执行的是：

```bash
pnpm lint && pnpm format && git add . && pnpm spellcheck
```

这意味着：

- lint / format 问题会在提交前自动修复
- 被格式化过的文件会自动重新 `git add`
- 文档和代码拼写会在 commit 前被检查

### 提交辅助命令

建议使用交互式提交助手：

```bash
pnpm commit
```

它基于 Commitizen + cz-git，和 `commitlint.config.js` 里的规则是一致的。

### Commit 格式

仓库使用 conventional commits。scope 支持：

- 从 `packages/`、`apps/`、`examples/` 自动扫描出的 package / app 路径
- 通用 scope，例如 `docs`、`project`、`style`、`ci`、`dev`、`deploy`、`other`

示例：

- `docs(docs): split deployment guide from root readme`
- `fix(backend/monitor): prevent duplicate application names`
- `feat(packages/ai): add semantic trace metadata`

如果你不确定 scope 怎么写，直接用 `pnpm commit` 最稳妥。

---

## Pull Request 检查清单

发 PR 前请确认：

- 改动范围聚焦、描述清楚
- 本地已运行必要检查
- 控制台 UI 改动附上截图或短录屏
- 新增 env、路由变化、数据结构变化都已写进文档
- 没有提交任何 secret 或私有 token
- 行为变化涉及文档时已同步更新

PR 描述建议至少写清：

- 改了什么
- 为什么改
- 怎么验证的
- 是否还有后续工作或部署注意事项

按改动类型，建议额外写上的信息：

- 部署改动 -> 改了哪些 compose、Caddy、Dockerfile、env
- SDK 改动 -> 影响了哪些事件类型，怎么验证
- 后端 API 改动 -> 改了哪些接口，请求/响应变化，以及兼容性影响
