English | [中文](./README.zh-CN.md)

# ConDev Monitor

ConDev Monitor is a frontend monitoring platform designed to help developers understand user interactions, debug issues, and optimize user experience. Built with a modern, scalable architecture, it leverages a monorepo structure to unify its ingestion services, API backend, frontend dashboard, and browser SDKs.

## Features

- **Session Replay:** High-fidelity recording and replay of user sessions using `rrweb`.
- **Scalable Ingestion:** Dedicated `dsn-server` for high-throughput event ingestion.
- **Analytics:** Powered by ClickHouse for real-time, blazing-fast analytics queries.
- **Modern Stack:** Built with TypeScript, NestJS, Next.js, and TurboRepo.
- **Self-Hostable:** complete Docker Compose setup for easy deployment.

## Tech Stack

- **Monorepo:** [TurboRepo](https://turbo.build/) & [PNPM](https://pnpm.io/)
- **Frontend:** [Next.js](https://nextjs.org/) (React)
- **Backend:** [NestJS](https://nestjs.com/)
- **Databases:**
    - [ClickHouse](https://clickhouse.com/) (Session data & Analytics)
    - [PostgreSQL](https://www.postgresql.org/) (Application data)
    - [Redis](https://redis.io/) (Caching & Queues)
- **SDK:** Custom browser SDK utilizing [rrweb](https://github.com/rrweb-io/rrweb)

## Project Structure

```bash
condev-monitor/
├── apps/
│   ├── backend/
│   │   ├── dsn-server/    # High-performance data ingestion service
│   │   └── monitor/       # Main API server (Business logic, Auth, etc.)
│   └── frontend/
│       └── monitor/       # Admin dashboard & Replay viewer (Next.js)
├── packages/
│   ├── browser/           # Browser SDK for session recording
│   ├── browser-utils/     # Shared browser utilities
│   └── core/              # Core shared logic and types
├── .devcontainer/         # Docker Compose configurations
└── scripts/               # Utility scripts (e.g., ClickHouse initialization)
```

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v20+ recommended)
- [PNPM](https://pnpm.io/) (`npm install -g pnpm`)
- [Docker](https://www.docker.com/) & Docker Compose

### Local Development Setup

1.  **Clone the repository:**

    ```bash
    git clone https://github.com/your-org/condev-monitor.git
    cd condev-monitor
    ```

2.  **Install dependencies:**

    ```bash
    pnpm install
    ```

3.  **Start Infrastructure:**
    Spin up the required databases (ClickHouse, Postgres, Redis) using Docker.

    ```bash
    pnpm docker:start
    ```

4.  **Initialize ClickHouse:**
    Create the necessary tables and schemas.

    ```bash
    pnpm docker:init-clickhouse
    ```

5.  **Run Development Servers:**
    Start all applications (Frontend, Backend API, DSN Server) in development mode.

    ```bash
    pnpm start:dev
    ```

    - **Frontend:** http://localhost:3000 (Check terminal for exact port)
    - **API:** http://localhost:3001 (Check terminal for exact port)

### Deployment

To deploy the stack using Docker Compose:

```bash
pnpm docker:deploy
```

Deployment notes:

- `.devcontainer/docker-compose.deply.yml` runs `condev-dsn-server` with Postgres access so it can resolve `appId -> owner email` for alert emails.
- Configure email + fallback recipients in `.devcontainer/.env` (see `.devcontainer/.env.example`).

To stop the deployment:

```bash
pnpm docker:deploy:stop
```

## Quality Control

- **Linting:** `pnpm lint`
- **Formatting:** `pnpm format`
- **Type Checking:** `pnpm check`

## Contributing

Contributions are welcome! Please ensure you adhere to the project's coding standards.

1.  Fork the repository.
2.  Create your feature branch (`git checkout -b feature/amazing-feature`).
3.  Commit your changes (`git commit -m 'feat: add some amazing feature'`).
4.  Push to the branch (`git push origin feature/amazing-feature`).
5.  Open a Pull Request.

## License

This project is licensed under the Apache-2.0 License - see the [LICENSE](LICENSE) file for details.
