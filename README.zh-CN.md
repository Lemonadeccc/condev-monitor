[English](./README.md) | 中文

# ConDev Monitor

ConDev Monitor 是一个前端监控平台，旨在帮助开发者理解用户交互、调试问题并优化用户体验。它采用现代化的可扩展架构构建，利用 Monorepo 结构统一了数据摄取服务、API 后端、前端仪表盘和浏览器 SDK。

## 功能特性

- **会话回放:** 使用 `rrweb` 进行高保真的用户会话录制和回放。
- **可扩展摄取:** 专用的 `dsn-server` 用于高吞吐量事件摄取。
- **分析:** 由 ClickHouse 驱动，支持实时、极速的分析查询。
- **现代技术栈:** 基于 TypeScript, NestJS, Next.js 和 TurboRepo 构建。
- **支持自托管:** 提供完整的 Docker Compose 设置，便于部署。

## 技术栈

- **Monorepo:** [TurboRepo](https://turbo.build/) & [PNPM](https://pnpm.io/)
- **前端:** [Next.js](https://nextjs.org/) (React)
- **后端:** [NestJS](https://nestjs.com/)
- **数据库:**
    - [ClickHouse](https://clickhouse.com/) (会话数据 & 分析)
    - [PostgreSQL](https://www.postgresql.org/) (应用数据)
    - [Redis](https://redis.io/) (缓存 & 队列)
- **SDK:** 基于 [rrweb](https://github.com/rrweb-io/rrweb) 的自定义浏览器 SDK

## 项目结构

```bash
condev-monitor/
├── apps/
│   ├── backend/
│   │   ├── dsn-server/    # 高性能数据摄取服务
│   │   └── monitor/       # 主 API 服务器 (业务逻辑, 认证等)
│   └── frontend/
│       └── monitor/       # 管理仪表盘 & 回放查看器 (Next.js)
├── packages/
│   ├── browser/           # 用于会话录制的浏览器 SDK
│   ├── browser-utils/     # 共享浏览器工具
│   └── core/              # 核心共享逻辑和类型
├── .devcontainer/         # Docker Compose 配置
└── scripts/               # 实用脚本 (例如: ClickHouse 初始化)
```

## 快速开始

### 前置要求

- [Node.js](https://nodejs.org/) (推荐 v20+)
- [PNPM](https://pnpm.io/) (`npm install -g pnpm`)
- [Docker](https://www.docker.com/) & Docker Compose

### 本地开发设置

1.  **克隆仓库:**

    ```bash
    git clone https://github.com/your-org/condev-monitor.git
    cd condev-monitor
    ```

2.  **安装依赖:**

    ```bash
    pnpm install
    ```

3.  **启动基础设施:**
    使用 Docker 启动所需的数据库 (ClickHouse, Postgres, Redis)。

    ```bash
    pnpm docker:start
    ```

4.  **初始化 ClickHouse:**
    创建必要的表和 schema。

    ```bash
    pnpm docker:init-clickhouse
    ```

5.  **运行开发服务器:**
    以开发模式启动所有应用程序 (前端, 后端 API, DSN Server)。

    ```bash
    pnpm start:dev
    ```

    - **前端:** http://localhost:3000 (请检查终端以获取确切端口)
    - **API:** http://localhost:3001 (请检查终端以获取确切端口)

### 部署

使用 Docker Compose 部署整个栈:

```bash
pnpm docker:deploy
```

停止部署:

```bash
pnpm docker:deploy:stop
```

## 质量控制

- **代码检查:** `pnpm lint`
- **格式化:** `pnpm format`
- **类型检查:** `pnpm check`

## 贡献

欢迎贡献！请确保遵守项目的编码规范。

1.  Fork 本仓库。
2.  创建你的特性分支 (`git checkout -b feature/amazing-feature`)。
3.  提交你的更改 (`git commit -m 'feat: add some amazing feature'`)。
4.  推送到分支 (`git push origin feature/amazing-feature`)。
5.  开启一个 Pull Request。

## 许可证

本项目基于 Apache-2.0 许可证开源 - 详情请参阅 [LICENSE](LICENSE) 文件。
