# AISDK RAG Chatbox

基于 Next.js + Vercel AI SDK 的 RAG 聊天应用，支持 PDF 上传、向量检索与流式对话。

语言：简体中文 | [English](README.md)

## 项目简介

这是一个“上传文档 -> 向量化 -> 检索增强对话”的示例项目。管理员可在 `/upload` 上传 PDF，系统会将其切分为文本块并生成向量，存入 Neon Postgres（pgvector）；用户在 `/chat` 发起对话时，服务端会先检索相关片段，再由模型基于检索结果生成回答。

## 功能特性

- PDF 文档解析与分块（`pdf-parse` + `@langchain/textsplitters`）
- OpenAI 向量嵌入（`text-embedding-3-small`，1536 维）
- pgvector + HNSW 向量索引检索
- Vercel AI SDK 流式对话与工具调用
- Clerk 登录与管理员访问控制（`/upload` 仅管理员）

## 架构与技术选型

- 前端框架：Next.js App Router + React 19
- AI 能力：Vercel AI SDK（`ai`、`@ai-sdk/react`）
- 模型提供方：OpenAI（可切换为 DeepSeek）
- 向量数据库：Neon Postgres + pgvector
- ORM/迁移：Drizzle ORM + Drizzle Kit
- UI：Radix UI + Tailwind CSS

## 功能流程（核心链路）

1. 管理员在 `/upload` 上传 PDF（`src/app/upload/page.tsx`）。
2. 服务端动作 `processPdfFile` 提取文本并切分（`src/app/upload/actions.ts`、`src/lib/chunking.ts`）。
3. 调用 OpenAI 生成 embedding（`src/lib/embeddings.ts`）。
4. 将文本块与向量写入 `documents` 表（`src/lib/db-schema.ts`）。
5. 用户在 `/chat` 输入问题，`useChat` 向 `/api/chat` 发送消息并接收流式回复（`src/app/chat/page.tsx`）。
6. `/api/chat` 的工具 `searchKnowledgeBase` 生成查询向量并执行相似度检索（`src/lib/search.ts`）。
7. 模型 `gpt-5-mini` 基于检索结果组织回答并流式返回（`src/app/api/chat/route.ts`）。

## 项目结构

- `src/app/chat/page.tsx`: 聊天界面（客户端）
- `src/app/api/chat/route.ts`: 聊天 API（工具检索 + 流式输出）
- `src/app/upload/page.tsx`: PDF 上传界面
- `src/app/upload/actions.ts`: PDF 解析与入库
- `src/lib/chunking.ts`: 文本切分策略
- `src/lib/embeddings.ts`: 向量生成
- `src/lib/search.ts`: 向量检索
- `src/lib/db-schema.ts`: 数据库表结构与索引
- `migrations/*`: pgvector 扩展与表结构迁移

## 环境变量

在 `.env.local` 中配置（参见 `.env.example`）：

- `OPENAI_API_KEY`: OpenAI Key（聊天与 embedding）
- `NEON_DATABASE_URL`: Neon Postgres 连接串
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`: Clerk 公钥
- `CLERK_SECRET_KEY`: Clerk 私钥
- `DEEPSEEK_API_KEY`: 可选，切换 DeepSeek 时使用

## 本地运行

1. 安装依赖：`pnpm install`
2. 配置 `.env.local`
3. 初始化数据库与迁移：
    - `pnpm drizzle-kit migrate`
4. 启动开发：`pnpm dev`
5. 访问：
    - `http://localhost:3000/chat` 聊天页面
    - `http://localhost:3000/upload` 上传页面（需管理员）

## 数据库与向量索引

迁移包含：

- `CREATE EXTENSION vector;`
- `documents` 表（`content` + `embedding`）
- HNSW 索引（`vector_cosine_ops`）

## 其他说明

- 访问控制：`src/middleware.ts` 中限制 `/upload` 仅管理员访问，需要在 Clerk 中为用户设置 `metadata.role=admin`。
- 模型切换：`src/app/api/chat/route.ts` 默认使用 OpenAI，可切换到 DeepSeek（已预留注释）。
- 相似度阈值与数量：`searchDocuments(query, 3, 0.5)` 可按需调整。

## 开源信息

当前仓库未包含 `LICENSE` 文件，如需开源发布请补充许可证与贡献指南。
