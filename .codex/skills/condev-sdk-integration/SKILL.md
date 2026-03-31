---
name: condev-sdk-integration
description: Use when integrating Condev Monitor into an existing AI application. Supports two concrete patterns: 1) Next.js + Vercel AI SDK projects, and 2) React/Vite frontends with a separate FastAPI-style RAG backend. Use this skill when asked to add AI streaming, AI traces, sessions, users, cost, replay, or user sync using the Condev SDK.
---

# Condev SDK Integration

Pick the variant first, then read only the relevant reference:

- **Next.js + Vercel AI SDK**
  Read [references/nextjs-vercel-ai-sdk.md](references/nextjs-vercel-ai-sdk.md)
- **React/Vite frontend + FastAPI-style RAG backend**
  Read [references/react-fastapi-rag.md](references/react-fastapi-rag.md)

## Workflow

1. Identify the project shape:
    - App Router / `useChat` / `ai` package => Next.js + Vercel AI SDK
    - Vite frontend + separate backend chat endpoint => React/Vite + FastAPI-style RAG
2. Add DSN env vars first.
3. Wire the browser SDK.
4. Wire session/user propagation.
5. Wire backend semantic traces if the stack has a backend AI service.
6. Validate against monitor pages:
    - `AI Streaming`
    - `AI Traces`
    - `AI Sessions`
    - `AI Users`
    - `AI Cost`

## Repository References

Use these examples in this repo as the canonical implementation references:

- Next.js + Vercel AI SDK:
  [examples/aisdk-rag-chatbox/README.md](../../../examples/aisdk-rag-chatbox/README.md)
- React/Vite + FastAPI RAG:
  [examples/rag/README.md](../../../examples/rag/README.md)

## Do Not Do

- Do not only wire the frontend and expect `AI Traces` to appear for backend-driven apps.
- Do not hardcode a fake user in production examples; sync the real logged-in business user.
- Do not guess the streaming path; use the app's real API route in `urlPatterns`.
