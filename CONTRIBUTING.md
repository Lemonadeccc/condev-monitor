English | [中文](./CONTRIBUTING.zh-CN.md)

# Contributing to Condev Monitor

This guide covers the local development workflow, repository checks, commit conventions, and the expected shape of pull requests.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Local Setup](#local-setup)
- [Running the Repository](#running-the-repository)
- [Quality Checks](#quality-checks)
- [Git Hooks and Commit Messages](#git-hooks-and-commit-messages)
- [Pull Request Checklist](#pull-request-checklist)

---

## Prerequisites

- Node.js `22.15+`
- pnpm `10.10.0`
- Docker + Docker Compose

---

## Local Setup

### 1. Install dependencies

```bash
pnpm install
```

### 2. Prepare env files

```bash
cp apps/backend/monitor/.env.example apps/backend/monitor/.env
cp apps/backend/dsn-server/.env.example apps/backend/dsn-server/.env
```

If your work touches deployment compose or infra behavior, also prepare:

```bash
cp .devcontainer/.env.example .devcontainer/.env
```

### 3. Start local infrastructure

```bash
pnpm docker:start
```

This starts local ClickHouse, Postgres, and Kafka, then initializes the ClickHouse schema and Kafka topics automatically.

---

## Running the Repository

### Start all backends

```bash
pnpm start:dev
```

This runs workspace `start:dev` scripts through Turbo and starts:

- `apps/backend/monitor`
- `apps/backend/dsn-server`
- `apps/backend/event-worker`

### Start the dashboard

```bash
pnpm start:fro
```

If your backends are not on the default localhost ports:

```bash
API_PROXY_TARGET=http://127.0.0.1:8081 \
DSN_API_PROXY_TARGET=http://127.0.0.1:8082 \
pnpm start:fro
```

### Start a specific package

```bash
pnpm --filter monitor start:dev
pnpm --filter dsn-server start:dev
pnpm --filter event-worker start:dev
pnpm --filter @condev-monitor/monitor-client dev
pnpm --filter vanilla dev
pnpm --filter aisdk-rag-chatbox dev
```

Use `examples/vanilla` when you need fast manual verification for SDK behavior such as:

- JS error capture
- white-screen checks
- performance signals
- replay capture
- sourcemap upload
- transport batching / retry behavior

---

## Quality Checks

### Repository-level checks

```bash
pnpm lint
pnpm format:check
pnpm spellcheck
```

Notes:

- `pnpm lint` runs ESLint with `--fix`
- `pnpm format:check` is the non-writing formatting validation
- `pnpm check` exists, but it runs `pnpm format`, which writes files. Use it when you want autofix behavior, not when you want a read-only gate

### Backend tests

```bash
pnpm --filter monitor test
pnpm --filter monitor test:e2e
pnpm --filter dsn-server test
pnpm --filter dsn-server test:e2e
pnpm --filter event-worker test
```

### Frontend validation

The dashboard currently relies primarily on build validation:

```bash
pnpm --filter @condev-monitor/monitor-client build
```

### Before opening a PR

At minimum, run the subset relevant to your change:

- backend changes -> lint + affected backend tests (including event-worker if ingest/Kafka logic changed)
- frontend changes -> lint + frontend build
- SDK changes -> lint + package build + `examples/vanilla` manual verification when behavior changed
- docs-only changes -> spellcheck the touched markdown if needed

---

## Git Hooks and Commit Messages

### Pre-commit hook

The repository has a Husky pre-commit hook at `.husky/pre-commit` that runs:

```bash
pnpm lint && pnpm format && git add . && pnpm spellcheck
```

That means:

- lint and format issues are auto-fixed before commit
- files changed by formatting are re-added automatically
- markdown and code spelling is checked before the commit finishes

### Commit helper

Use the interactive commit helper:

```bash
pnpm commit
```

This uses Commitizen + cz-git and is aligned with the commitlint configuration in `commitlint.config.js`.

### Commit format

The repository expects conventional commits. Valid scopes include:

- package and app paths discovered from `packages/`, `apps/`, and `examples/`
- generic scopes such as `docs`, `project`, `style`, `ci`, `dev`, `deploy`, `other`

Examples:

- `docs(docs): split deployment guide from root readme`
- `fix(backend/monitor): prevent duplicate application names`
- `feat(packages/ai): add semantic trace metadata`

If you are unsure about the scope, `pnpm commit` is the safer path.

---

## Pull Request Checklist

Before opening a PR, verify:

- the change is scoped and described clearly
- required checks have been run locally
- screenshots or short recordings are included for dashboard UI changes
- new env vars, route changes, or data model changes are documented
- no secrets or private tokens are committed
- related docs are updated when behavior changed

When writing the PR description, include:

- what changed
- why it changed
- how it was tested
- any follow-up work or deployment caveats

Recommended manual notes by change type:

- deployment changes -> mention touched compose, Caddy, Dockerfile, and env vars
- SDK changes -> mention affected event types and validation steps
- backend API changes -> list endpoints, request/response changes, and backward-compatibility impact
