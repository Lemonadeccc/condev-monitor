from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any, Literal, Mapping, Protocol, Sequence, TypedDict
from uuid import uuid4

SpanKind = Literal[
    "entrypoint",
    "llm",
    "retrieval",
    "rerank",
    "embedding",
    "chain",
    "tool",
    "graph_node",
    "load",
    "split",
    "transform",
    "cache",
    "stage",
    "event",
]
Status = Literal["ok", "error", "cancelled"]
EventType = Literal["ai_span", "ai_feedback", "ai_ingestion_run", "ai_evaluation"]


class ScorePayload(TypedDict, total=False):
    name: str
    value: float
    comment: str


class CondevObservationEvent(TypedDict, total=False):
    event_type: EventType
    traceId: str
    spanId: str
    parentSpanId: str
    spanKind: SpanKind
    name: str
    status: Status
    startedAt: str
    endedAt: str
    durationMs: int
    input: Any
    output: Any
    model: str
    provider: str
    inputTokens: int
    outputTokens: int
    userId: str
    sessionId: str
    environment: str
    release: str
    tags: list[str]
    metadata: dict[str, Any]
    attributes: dict[str, Any]
    source: str
    framework: str
    score: ScorePayload
    errorMessage: str
    createdAt: str
    value: float
    comment: str
    appId: str


class ReporterLike(Protocol):
    def send(self, event: Mapping[str, Any]) -> None:
        ...

    def flush(self, timeout: float | None = None) -> None:
        ...

    def shutdown(self, timeout: float | None = None) -> None:
        ...


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _duration_ms(started_at: float) -> int:
    return max(0, int(round((time.perf_counter() - started_at) * 1000)))


def _compact_mapping(payload: Mapping[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in payload.items() if value is not None}


def _copy_mapping(mapping: Mapping[str, Any] | None) -> dict[str, Any] | None:
    return dict(mapping) if mapping else None


def _merge_tags(inherited: Sequence[str] | None, extra: Sequence[str] | None) -> list[str] | None:
    merged: list[str] = []
    seen: set[str] = set()
    for group in (inherited, extra):
        for tag in group or ():
            normalized = str(tag)
            if normalized and normalized not in seen:
                seen.add(normalized)
                merged.append(normalized)
    return merged or None


def _merge_metadata(
    metadata: Mapping[str, Any] | None,
    model_parameters: Mapping[str, Any] | None,
) -> dict[str, Any] | None:
    merged: dict[str, Any] = {}
    if metadata:
        merged.update(dict(metadata))
    if model_parameters:
        merged["modelParameters"] = dict(model_parameters)
    return merged or None


def _merge_error_attributes(
    attributes: Mapping[str, Any] | None,
    error_message: str | None,
) -> dict[str, Any] | None:
    merged = dict(attributes) if attributes else {}
    if error_message and "error" not in merged:
        merged["error"] = error_message
    return merged or None


def _extract_usage_token(usage: Mapping[str, Any] | None, *keys: str) -> int | None:
    if not usage:
        return None
    for key in keys:
        value = usage.get(key)
        if value is None:
            continue
        try:
            return int(value)
        except (TypeError, ValueError):
            return None
    return None


class CondevAIClient:
    def __init__(
        self,
        reporter: ReporterLike,
        *,
        source: str = "python-sdk",
        framework: str = "manual",
        environment: str | None = None,
        release: str | None = None,
    ) -> None:
        self._reporter = reporter
        self._source = source
        self._framework = framework
        self._environment = environment
        self._release = release

    def trace(
        self,
        name: str,
        *,
        trace_id: str | None = None,
        input: Any = None,
        session_id: str | None = None,
        user_id: str | None = None,
        metadata: Mapping[str, Any] | None = None,
        attributes: Mapping[str, Any] | None = None,
        tags: Sequence[str] | None = None,
        environment: str | None = None,
        release: str | None = None,
    ) -> "CondevTrace":
        resolved_trace_id = trace_id or str(uuid4())
        common_fields = _compact_mapping(
            {
                "sessionId": session_id,
                "userId": user_id,
                "environment": environment or self._environment,
                "release": release or self._release,
                "source": self._source,
                "framework": self._framework,
            }
        )
        return CondevTrace(
            reporter=self._reporter,
            trace_id=resolved_trace_id,
            common_fields=common_fields,
            inherited_tags=tuple(tags or ()),
            name=name,
            input=input,
            metadata=metadata,
            attributes=attributes,
        )

    def flush(self, timeout: float | None = None) -> None:
        flush = getattr(self._reporter, "flush", None)
        if callable(flush):
            flush(timeout=timeout)

    def shutdown(self, timeout: float | None = None) -> None:
        shutdown = getattr(self._reporter, "shutdown", None)
        if callable(shutdown):
            shutdown(timeout=timeout)


class CondevTrace:
    def __init__(
        self,
        *,
        reporter: ReporterLike,
        trace_id: str,
        common_fields: Mapping[str, Any],
        inherited_tags: Sequence[str],
        name: str,
        input: Any = None,
        metadata: Mapping[str, Any] | None = None,
        attributes: Mapping[str, Any] | None = None,
    ) -> None:
        self._reporter = reporter
        self.trace_id = trace_id
        self._common_fields = dict(common_fields)
        self._tags = tuple(inherited_tags)
        self._name = name
        self._started_at = time.perf_counter()
        self._ended = False

        self._emit(
            {
                "event_type": "ai_span",
                "traceId": self.trace_id,
                "spanId": self.trace_id,
                "parentSpanId": "",
                "spanKind": "entrypoint",
                "name": self._name,
                "input": input,
                "startedAt": _now_iso(),
                "metadata": _copy_mapping(metadata),
                "attributes": _copy_mapping(attributes),
                "tags": list(self._tags) if self._tags else None,
                **self._common_fields,
            }
        )

    def span(
        self,
        name: str,
        *,
        span_kind: SpanKind = "stage",
        input: Any = None,
        metadata: Mapping[str, Any] | None = None,
        attributes: Mapping[str, Any] | None = None,
        tags: Sequence[str] | None = None,
    ) -> "CondevSpan":
        return CondevSpan(
            reporter=self._reporter,
            trace_id=self.trace_id,
            parent_span_id=self.trace_id,
            common_fields=self._common_fields,
            inherited_tags=self._tags,
            name=name,
            span_kind=span_kind,
            input=input,
            metadata=metadata,
            attributes=attributes,
            tags=tags,
        )

    def generation(
        self,
        name: str,
        *,
        model: str | None = None,
        provider: str | None = None,
        model_parameters: Mapping[str, Any] | None = None,
        input: Any = None,
        metadata: Mapping[str, Any] | None = None,
        attributes: Mapping[str, Any] | None = None,
        tags: Sequence[str] | None = None,
    ) -> "CondevGeneration":
        return CondevGeneration(
            reporter=self._reporter,
            trace_id=self.trace_id,
            parent_span_id=self.trace_id,
            common_fields=self._common_fields,
            inherited_tags=self._tags,
            name=name,
            model=model,
            provider=provider,
            model_parameters=model_parameters,
            input=input,
            metadata=metadata,
            attributes=attributes,
            tags=tags,
        )

    def score(
        self,
        name: str,
        value: float,
        comment: str | None = None,
        *,
        metadata: Mapping[str, Any] | None = None,
        attributes: Mapping[str, Any] | None = None,
    ) -> None:
        self._emit(
            {
                "event_type": "ai_feedback",
                "traceId": self.trace_id,
                "spanId": self.trace_id,
                "name": name,
                "createdAt": _now_iso(),
                "value": float(value),
                "comment": comment,
                "score": {
                    "name": name,
                    "value": float(value),
                    "comment": comment,
                },
                "metadata": _copy_mapping(metadata),
                "attributes": _copy_mapping(attributes),
                "tags": list(self._tags) if self._tags else None,
                **self._common_fields,
            }
        )

    def end(
        self,
        output: Any = None,
        *,
        status: Status = "ok",
        metadata: Mapping[str, Any] | None = None,
        attributes: Mapping[str, Any] | None = None,
        error_message: str | None = None,
    ) -> None:
        if self._ended:
            return
        self._ended = True
        self._emit(
            {
                "event_type": "ai_span",
                "traceId": self.trace_id,
                "spanId": self.trace_id,
                "parentSpanId": "",
                "spanKind": "entrypoint",
                "name": self._name,
                "output": output,
                "status": status,
                "endedAt": _now_iso(),
                "durationMs": _duration_ms(self._started_at),
                "errorMessage": error_message,
                "metadata": _copy_mapping(metadata),
                "attributes": _merge_error_attributes(attributes, error_message),
                "tags": list(self._tags) if self._tags else None,
                **self._common_fields,
            }
        )

    update = end

    def __enter__(self) -> "CondevTrace":
        return self

    def __exit__(self, exc_type: object, exc: BaseException | None, tb: object) -> bool:
        if exc is None:
            self.end()
        else:
            self.end(status="error", error_message=str(exc))
        return False

    def _emit(self, payload: Mapping[str, Any]) -> None:
        self._reporter.send(_compact_mapping(payload))


class CondevSpan:
    def __init__(
        self,
        *,
        reporter: ReporterLike,
        trace_id: str,
        parent_span_id: str,
        common_fields: Mapping[str, Any],
        inherited_tags: Sequence[str],
        name: str,
        span_kind: SpanKind = "stage",
        input: Any = None,
        model: str | None = None,
        provider: str | None = None,
        metadata: Mapping[str, Any] | None = None,
        attributes: Mapping[str, Any] | None = None,
        tags: Sequence[str] | None = None,
    ) -> None:
        self._reporter = reporter
        self.trace_id = trace_id
        self.parent_span_id = parent_span_id
        self.span_id = str(uuid4())
        self._common_fields = dict(common_fields)
        self._tags = tuple(_merge_tags(inherited_tags, tags) or [])
        self._name = name
        self._span_kind = span_kind
        self._default_model = model
        self._default_provider = provider
        self._started_at = time.perf_counter()
        self._ended = False

        self._emit(
            {
                "event_type": "ai_span",
                "traceId": self.trace_id,
                "spanId": self.span_id,
                "parentSpanId": self.parent_span_id,
                "spanKind": self._span_kind,
                "name": self._name,
                "input": input,
                "model": self._default_model,
                "provider": self._default_provider,
                "startedAt": _now_iso(),
                "metadata": _copy_mapping(metadata),
                "attributes": _copy_mapping(attributes),
                "tags": list(self._tags) if self._tags else None,
                **self._common_fields,
            }
        )

    def span(
        self,
        name: str,
        *,
        span_kind: SpanKind = "stage",
        input: Any = None,
        metadata: Mapping[str, Any] | None = None,
        attributes: Mapping[str, Any] | None = None,
        tags: Sequence[str] | None = None,
    ) -> "CondevSpan":
        return CondevSpan(
            reporter=self._reporter,
            trace_id=self.trace_id,
            parent_span_id=self.span_id,
            common_fields=self._common_fields,
            inherited_tags=self._tags,
            name=name,
            span_kind=span_kind,
            input=input,
            metadata=metadata,
            attributes=attributes,
            tags=tags,
        )

    def generation(
        self,
        name: str,
        *,
        model: str | None = None,
        provider: str | None = None,
        model_parameters: Mapping[str, Any] | None = None,
        input: Any = None,
        metadata: Mapping[str, Any] | None = None,
        attributes: Mapping[str, Any] | None = None,
        tags: Sequence[str] | None = None,
    ) -> "CondevGeneration":
        return CondevGeneration(
            reporter=self._reporter,
            trace_id=self.trace_id,
            parent_span_id=self.span_id,
            common_fields=self._common_fields,
            inherited_tags=self._tags,
            name=name,
            model=model,
            provider=provider,
            model_parameters=model_parameters,
            input=input,
            metadata=metadata,
            attributes=attributes,
            tags=tags,
        )

    def end(
        self,
        output: Any = None,
        *,
        status: Status = "ok",
        model: str | None = None,
        provider: str | None = None,
        metadata: Mapping[str, Any] | None = None,
        attributes: Mapping[str, Any] | None = None,
        error_message: str | None = None,
    ) -> None:
        if self._ended:
            return
        self._ended = True
        self._emit(
            {
                "event_type": "ai_span",
                "traceId": self.trace_id,
                "spanId": self.span_id,
                "parentSpanId": self.parent_span_id,
                "spanKind": self._span_kind,
                "name": self._name,
                "output": output,
                "status": status,
                "model": model or self._default_model,
                "provider": provider or self._default_provider,
                "endedAt": _now_iso(),
                "durationMs": _duration_ms(self._started_at),
                "errorMessage": error_message,
                "metadata": _copy_mapping(metadata),
                "attributes": _merge_error_attributes(attributes, error_message),
                "tags": list(self._tags) if self._tags else None,
                **self._common_fields,
            }
        )

    def __enter__(self) -> "CondevSpan":
        return self

    def __exit__(self, exc_type: object, exc: BaseException | None, tb: object) -> bool:
        if exc is None:
            self.end()
        else:
            self.end(status="error", error_message=str(exc))
        return False

    def _emit(self, payload: Mapping[str, Any]) -> None:
        self._reporter.send(_compact_mapping(payload))


class CondevGeneration(CondevSpan):
    def __init__(
        self,
        *,
        reporter: ReporterLike,
        trace_id: str,
        parent_span_id: str,
        common_fields: Mapping[str, Any],
        inherited_tags: Sequence[str],
        name: str,
        model: str | None = None,
        provider: str | None = None,
        model_parameters: Mapping[str, Any] | None = None,
        input: Any = None,
        metadata: Mapping[str, Any] | None = None,
        attributes: Mapping[str, Any] | None = None,
        tags: Sequence[str] | None = None,
    ) -> None:
        self._model_parameters = _copy_mapping(model_parameters)
        super().__init__(
            reporter=reporter,
            trace_id=trace_id,
            parent_span_id=parent_span_id,
            common_fields=common_fields,
            inherited_tags=inherited_tags,
            name=name,
            span_kind="llm",
            input=input,
            model=model,
            provider=provider,
            metadata=_merge_metadata(metadata, self._model_parameters),
            attributes=attributes,
            tags=tags,
        )

    def end(
        self,
        output: Any = None,
        *,
        status: Status = "ok",
        model: str | None = None,
        provider: str | None = None,
        usage: Mapping[str, Any] | None = None,
        input_tokens: int | None = None,
        output_tokens: int | None = None,
        metadata: Mapping[str, Any] | None = None,
        attributes: Mapping[str, Any] | None = None,
        error_message: str | None = None,
    ) -> None:
        resolved_input_tokens = input_tokens if input_tokens is not None else _extract_usage_token(
            usage,
            "inputTokens",
            "input_tokens",
            "promptTokens",
            "prompt_tokens",
        )
        resolved_output_tokens = output_tokens if output_tokens is not None else _extract_usage_token(
            usage,
            "outputTokens",
            "output_tokens",
            "completionTokens",
            "completion_tokens",
        )

        if self._ended:
            return
        self._ended = True
        self._emit(
            {
                "event_type": "ai_span",
                "traceId": self.trace_id,
                "spanId": self.span_id,
                "parentSpanId": self.parent_span_id,
                "spanKind": "llm",
                "name": self._name,
                "output": output,
                "status": status,
                "model": model or self._default_model,
                "provider": provider or self._default_provider,
                "inputTokens": resolved_input_tokens,
                "outputTokens": resolved_output_tokens,
                "endedAt": _now_iso(),
                "durationMs": _duration_ms(self._started_at),
                "errorMessage": error_message,
                "metadata": _merge_metadata(metadata, self._model_parameters),
                "attributes": _merge_error_attributes(attributes, error_message),
                "tags": list(self._tags) if self._tags else None,
                **self._common_fields,
            }
        )