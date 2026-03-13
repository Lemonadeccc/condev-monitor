# AISDK RAG Chatbox

A RAG chat app built with Next.js + Vercel AI SDK, featuring PDF ingestion, vector search, and streaming chat.

Language: English | [简体中文](README.zh-CN.md)

### Overview

This project demonstrates a full RAG pipeline: upload PDFs, chunk and embed the text, store vectors in Neon Postgres (pgvector), and answer chat queries by retrieving relevant chunks before generating a response.

### Features

- PDF parsing and chunking (`pdf-parse` + `@langchain/textsplitters`)
- OpenAI embeddings (`text-embedding-3-small`, 1536 dims)
- pgvector + HNSW vector index search
- Streaming chat with Vercel AI SDK tool calling
- Clerk authentication and admin-only upload access

### Architecture & Tech Stack

- Frontend: Next.js App Router + React 19
- AI layer: Vercel AI SDK (`ai`, `@ai-sdk/react`)
- Model provider: OpenAI (DeepSeek optional)
- Vector store: Neon Postgres + pgvector
- ORM & migrations: Drizzle ORM + Drizzle Kit
- UI: Radix UI + Tailwind CSS

### End-to-End Flow

1. Admin uploads a PDF at `/upload` (`src/app/upload/page.tsx`).
2. `processPdfFile` extracts text and splits it into chunks (`src/app/upload/actions.ts`, `src/lib/chunking.ts`).
3. OpenAI embeddings are generated (`src/lib/embeddings.ts`).
4. Chunks + vectors are stored in `documents` (`src/lib/db-schema.ts`).
5. The `/chat` UI sends messages via `useChat` to `/api/chat` and streams responses (`src/app/chat/page.tsx`).
6. `/api/chat` calls `searchKnowledgeBase`, embedding the query and retrieving similar chunks (`src/lib/search.ts`).
7. The `gpt-5-mini` model answers based on retrieved context (`src/app/api/chat/route.ts`).

### Project Structure

- `src/app/chat/page.tsx`: Chat UI (client)
- `src/app/api/chat/route.ts`: Chat API (tool search + streaming)
- `src/app/upload/page.tsx`: PDF upload UI
- `src/app/upload/actions.ts`: PDF processing and ingestion
- `src/lib/chunking.ts`: Chunking strategy
- `src/lib/embeddings.ts`: Embedding helpers
- `src/lib/search.ts`: Vector search
- `src/lib/db-schema.ts`: DB schema and index
- `migrations/*`: pgvector extension and table migrations

### Environment Variables

Configure `.env.local` (see `.env.example`):

- `OPENAI_API_KEY`: OpenAI key (chat + embeddings)
- `NEON_DATABASE_URL`: Neon Postgres URL
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`: Clerk publishable key
- `CLERK_SECRET_KEY`: Clerk secret key
- `DEEPSEEK_API_KEY`: Optional (if switching to DeepSeek)

### Local Development

1. Install deps: `pnpm install`
2. Create `.env.local`
3. Run migrations:
    - `pnpm drizzle-kit migrate`
4. Start dev server: `pnpm dev`
5. Visit:
    - `http://localhost:3000/chat` for chat
    - `http://localhost:3000/upload` for upload (admin only)

### Database Notes

Migrations include:

- `CREATE EXTENSION vector;`
- `documents` table with `content` + `embedding`
- HNSW index using `vector_cosine_ops`

### Additional Notes

- Access control is enforced in `src/middleware.ts`; set `metadata.role=admin` in Clerk for upload access.
- Model selection is in `src/app/api/chat/route.ts` (OpenAI by default; DeepSeek commented).
- Retrieval defaults are `topK=3` and `threshold=0.5` (tunable).

### Open Source Info

There is currently no `LICENSE` file in the repository. Add one (plus contributing docs) if you plan to open source it.
