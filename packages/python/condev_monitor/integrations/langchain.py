from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Mapping

from ..reporter import CondevReporter

try:
    from langchain_core.callbacks.base import BaseCallbackHandler
except ImportError as exc:  # pragma: no cover - optional dependency
    BaseCallbackHandler = object  # type: ignore[assignment]
    _IMPORT_ERROR: Exception | None = exc
else:
    _IMPORT_ERROR = None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _duration_ms(started_at: float) -> int:
    return max(0, int(round((time.perf_counter() - started_at) * 1000)))


def _as_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


@dataclass(slots=True)
class _SpanState:
    span_id: str
    parent_span_id: str
    name: str
    span_kind: str
    started_at: float


class CondevCallbackHandler(BaseCallbackHandler):  # type: ignore[misc]
    name = "CondevCallbackHandler"
    raise_error = False
    run_inline = True

    def __init__(
        self,
        reporter: CondevReporter,
        trace_id: str,
        *,
        session_id: str | None = None,
        user_id: str | None = None,
        capture_prompts: bool = False,
    ) -> None:
        if _IMPORT_ERROR is not None:
            raise RuntimeError(
                "langchain-core is not installed. Install condev-monitor[langchain] to use CondevCallbackHandler."
            ) from _IMPORT_ERROR

        super().__init__()
        self._reporter = reporter
        self._trace_id = trace_id
        self._session_id = session_id
        self._user_id = user_id
        self._capture_prompts = capture_prompts
        self._spans: dict[str, _SpanState] = {}
        self._lock = threading.RLock()

    def on_chain_start(
        self,
        serialized: dict[str, Any],
        inputs: dict[str, Any],
        *,
        run_id: Any,
        parent_run_id: Any | None = None,
        **kwargs: Any,
    ) -> Any:
        root_span = parent_run_id is None
        self._start_span(
            serialized=serialized,
            run_id=run_id,
            parent_run_id=parent_run_id,
            default_name="chain",
            span_kind="entrypoint" if root_span else "chain",
            input_payload=inputs if self._capture_prompts else None,
            root_span=root_span,
        )

    def on_chain_end(self, outputs: Any, *, run_id: Any, **kwargs: Any) -> Any:
        self._finish_span(run_id=run_id, output=outputs if self._capture_prompts else None, status="ok")

    def on_chain_error(self, error: BaseException, *, run_id: Any, **kwargs: Any) -> Any:
        self._finish_span(run_id=run_id, status="error", error_message=str(error))

    def on_llm_start(
        self,
        serialized: dict[str, Any],
        prompts: list[str],
        *,
        run_id: Any,
        parent_run_id: Any | None = None,
        **kwargs: Any,
    ) -> Any:
        self._start_span(
            serialized=serialized,
            run_id=run_id,
            parent_run_id=parent_run_id,
            default_name="llm",
            span_kind="llm",
            input_payload=prompts if self._capture_prompts else None,
        )

    def on_chat_model_start(
        self,
        serialized: dict[str, Any],
        messages: Any,
        *,
        run_id: Any,
        parent_run_id: Any | None = None,
        **kwargs: Any,
    ) -> Any:
        self._start_span(
            serialized=serialized,
            run_id=run_id,
            parent_run_id=parent_run_id,
            default_name="chat_model",
            span_kind="llm",
            input_payload=messages if self._capture_prompts else None,
        )

    def on_llm_end(self, response: Any, *, run_id: Any, **kwargs: Any) -> Any:
        llm_output = getattr(response, "llm_output", None)
        if not isinstance(llm_output, Mapping):
            llm_output = {}
        usage = llm_output.get("token_usage") or llm_output.get("usage") or {}
        if not isinstance(usage, Mapping):
            usage = {}

        self._finish_span(
            run_id=run_id,
            output=getattr(response, "generations", None) if self._capture_prompts else None,
            status="ok",
            input_tokens=_as_int(
                usage.get("prompt_tokens")
                or usage.get("promptTokens")
                or usage.get("input_tokens")
                or usage.get("inputTokens")
            ),
            output_tokens=_as_int(
                usage.get("completion_tokens")
                or usage.get("completionTokens")
                or usage.get("output_tokens")
                or usage.get("outputTokens")
            ),
            model=llm_output.get("model_name") or llm_output.get("model"),
            provider=llm_output.get("provider") or llm_output.get("provider_name"),
        )

    def on_llm_error(self, error: BaseException, *, run_id: Any, **kwargs: Any) -> Any:
        self._finish_span(run_id=run_id, status="error", error_message=str(error))

    def on_tool_start(
        self,
        serialized: dict[str, Any],
        input_str: str,
        *,
        run_id: Any,
        parent_run_id: Any | None = None,
        **kwargs: Any,
    ) -> Any:
        self._start_span(
            serialized=serialized,
            run_id=run_id,
            parent_run_id=parent_run_id,
            default_name="tool",
            span_kind="tool",
            input_payload=input_str if self._capture_prompts else None,
        )

    def on_tool_end(self, output: Any, *, run_id: Any, **kwargs: Any) -> Any:
        self._finish_span(run_id=run_id, output=output if self._capture_prompts else None, status="ok")

    def on_tool_error(self, error: BaseException, *, run_id: Any, **kwargs: Any) -> Any:
        self._finish_span(run_id=run_id, status="error", error_message=str(error))

    def on_retriever_start(
        self,
        serialized: dict[str, Any],
        query: str,
        *,
        run_id: Any,
        parent_run_id: Any | None = None,
        **kwargs: Any,
    ) -> Any:
        self._start_span(
            serialized=serialized,
            run_id=run_id,
            parent_run_id=parent_run_id,
            default_name="retriever",
            span_kind="retrieval",
            input_payload=query if self._capture_prompts else None,
        )

    def on_retriever_end(self, documents: Any, *, run_id: Any, **kwargs: Any) -> Any:
        hits = len(documents) if isinstance(documents, list) else None
        attributes = {"hits": hits} if hits is not None else None
        self._finish_span(
            run_id=run_id,
            output=documents if self._capture_prompts else None,
            status="ok",
            attributes=attributes,
        )

    def on_retriever_error(self, error: BaseException, *, run_id: Any, **kwargs: Any) -> Any:
        self._finish_span(run_id=run_id, status="error", error_message=str(error))

    def _start_span(
        self,
        *,
        serialized: Mapping[str, Any],
        run_id: Any,
        parent_run_id: Any | None,
        default_name: str,
        span_kind: str,
        input_payload: Any,
        root_span: bool = False,
    ) -> None:
        run_key = str(run_id)
        span_id = self._trace_id if root_span else run_key
        parent_span_id = "" if root_span else self._resolve_parent_span_id(parent_run_id)
        state = _SpanState(
            span_id=span_id,
            parent_span_id=parent_span_id,
            name=self._resolve_name(serialized, default_name),
            span_kind=span_kind,
            started_at=time.perf_counter(),
        )
        with self._lock:
            self._spans[run_key] = state

        self._reporter.send(
            {
                "event_type": "ai_span",
                "traceId": self._trace_id,
                "spanId": state.span_id,
                "parentSpanId": state.parent_span_id,
                "spanKind": state.span_kind,
                "name": state.name,
                "startedAt": _now_iso(),
                "input": input_payload,
                "sessionId": self._session_id,
                "userId": self._user_id,
                "source": "python-sdk",
                "framework": "langchain",
            }
        )

    def _finish_span(
        self,
        *,
        run_id: Any,
        status: str,
        output: Any = None,
        attributes: Mapping[str, Any] | None = None,
        input_tokens: int | None = None,
        output_tokens: int | None = None,
        model: Any = None,
        provider: Any = None,
        error_message: str | None = None,
    ) -> None:
        with self._lock:
            state = self._spans.pop(str(run_id), None)
        if state is None:
            return

        merged_attributes = dict(attributes) if attributes else {}
        if error_message:
            merged_attributes.setdefault("error", error_message)

        self._reporter.send(
            {
                "event_type": "ai_span",
                "traceId": self._trace_id,
                "spanId": state.span_id,
                "parentSpanId": state.parent_span_id,
                "spanKind": state.span_kind,
                "name": state.name,
                "endedAt": _now_iso(),
                "durationMs": _duration_ms(state.started_at),
                "status": status,
                "output": output,
                "inputTokens": input_tokens,
                "outputTokens": output_tokens,
                "model": str(model) if model is not None else None,
                "provider": str(provider) if provider is not None else None,
                "errorMessage": error_message,
                "attributes": merged_attributes or None,
                "sessionId": self._session_id,
                "userId": self._user_id,
                "source": "python-sdk",
                "framework": "langchain",
            }
        )

    def _resolve_parent_span_id(self, parent_run_id: Any | None) -> str:
        if parent_run_id is None:
            return self._trace_id
        with self._lock:
            parent = self._spans.get(str(parent_run_id))
        return parent.span_id if parent else str(parent_run_id)

    def _resolve_name(self, serialized: Mapping[str, Any], default_name: str) -> str:
        name = serialized.get("name")
        if isinstance(name, str) and name:
            return name
        raw_id = serialized.get("id")
        if isinstance(raw_id, (list, tuple)) and raw_id:
            tail = raw_id[-1]
            if isinstance(tail, str) and tail:
                return tail
        return default_name