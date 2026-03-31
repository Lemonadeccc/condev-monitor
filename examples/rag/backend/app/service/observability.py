from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

import tiktoken

from utils import logger


def _bootstrap_monorepo_python_sdk() -> None:
    current = Path(__file__).resolve()
    for parent in current.parents:
        candidate = parent / "packages" / "python"
        if (candidate / "condev_monitor").exists():
            sys.path.insert(0, str(candidate))
            return


_bootstrap_monorepo_python_sdk()

try:
    from condev_monitor import CondevAIClient, CondevReporter
except Exception as exc:  # pragma: no cover - optional dependency bootstrapping
    CondevAIClient = None  # type: ignore[assignment]
    CondevReporter = None  # type: ignore[assignment]
    logger.warning(f"Condev Python SDK unavailable, AI observability disabled: {exc}")


_reporter: CondevReporter | None = None
_client: CondevAIClient | None = None

_SPAN_POLICY_ATTRIBUTES: dict[str, dict[str, str]] = {
    "rag.chat_on_docs": {
        "component": "session",
        "importance": "primary",
        "failureImpact": "fatal",
        "displayGroup": "response",
        "description": "Root trace for the chat request.",
    },
    "rag.chat.completion": {
        "component": "llm",
        "importance": "primary",
        "failureImpact": "fatal",
        "displayGroup": "response",
        "description": "Primary answer generation. Failure means the request failed.",
    },
    "rag.retrieve_content": {
        "component": "retrieval",
        "importance": "supporting",
        "failureImpact": "degraded",
        "displayGroup": "retrieval",
        "description": "Knowledge retrieval. Failure degrades answer quality but does not always block a response.",
    },
    "rag.recommended_questions": {
        "component": "postprocess",
        "importance": "auxiliary",
        "failureImpact": "warning",
        "displayGroup": "postprocess",
        "description": "Suggested follow-up questions shown after the main answer.",
    },
    "rag.session_name": {
        "component": "postprocess",
        "importance": "auxiliary",
        "failureImpact": "warning",
        "displayGroup": "postprocess",
        "description": "Session title generation after the main answer completes.",
    },
    "stream.cancelled": {
        "component": "transport",
        "importance": "diagnostic",
        "failureImpact": "ignore",
        "displayGroup": "transport",
        "description": "Client-side cancellation or disconnect event used for diagnostics.",
    },
}


def get_condev_ai_client() -> CondevAIClient | None:
    global _reporter, _client

    dsn = (
        os.getenv("CONDEV_SERVER_DSN")
        or os.getenv("CONDEV_DSN")
        or os.getenv("NEXT_PUBLIC_CONDEV_DSN")
    )
    if not dsn or CondevReporter is None or CondevAIClient is None:
        return None

    if _reporter is None:
        _reporter = CondevReporter(dsn, debug=os.getenv("CONDEV_DEBUG") == "1")
    if _client is None:
        _client = CondevAIClient(
            _reporter,
            framework="fastapi",
            environment=os.getenv("CONDEV_ENVIRONMENT"),
            release=os.getenv("CONDEV_RELEASE"),
        )
    return _client


def shutdown_condev() -> None:
    global _client, _reporter

    if _client is not None:
        try:
            _client.shutdown(timeout=3.0)
        except Exception as exc:
            logger.warning(f"Condev shutdown failed: {exc}")
        finally:
            _client = None
            _reporter = None


def span_policy_attributes(name: str) -> dict[str, str]:
    return dict(_SPAN_POLICY_ATTRIBUTES.get(name, {}))


def start_chat_trace(*, trace_id: str | None, session_id: str, user_id: str, question: str):
    client = get_condev_ai_client()
    if client is None:
        return None

    return client.trace(
        "rag.chat_on_docs",
        trace_id=trace_id,
        input=[{"role": "user", "content": question}],
        session_id=session_id,
        user_id=user_id,
        metadata={"route": "/chat_on_docs"},
        attributes=span_policy_attributes("rag.chat_on_docs"),
    )


def infer_provider_name() -> str:
    base_url = (os.getenv("DASHSCOPE_BASE_URL") or "").lower()
    if "dashscope" in base_url:
        return "dashscope"
    if "openai" in base_url:
        return "openai-compatible"
    return "openai-compatible"


def estimate_token_count(value: Any, *, model: str | None = None) -> int | None:
    if value is None:
        return None

    if isinstance(value, str):
        text = value
    else:
        text = str(value)

    if not text.strip():
        return 0

    try:
        encoding = tiktoken.encoding_for_model(model or "gpt-4o-mini")
    except Exception:
        encoding = tiktoken.get_encoding("cl100k_base")

    try:
        return len(encoding.encode(text))
    except Exception:
        return max(1, len(text) // 4)
