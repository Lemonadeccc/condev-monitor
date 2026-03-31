from __future__ import annotations

import logging
import queue
import threading
import time
from dataclasses import dataclass
from typing import Any, Mapping
from urllib.parse import urlparse, urlunparse
from uuid import UUID

import httpx

SDK_VERSION = "0.1.0"
_LOGGER = logging.getLogger("condev_monitor")


@dataclass(frozen=True, slots=True)
class ParsedDsn:
    app_id: str | None
    ingest_url: str


@dataclass(slots=True)
class ReporterOptions:
    dsn: str
    timeout: float = 5.0
    max_batch_size: int = 100
    max_queue_size: int = 10000
    flush_interval: float = 0.25
    retries: int = 3
    backoff_base: float = 0.5
    debug: bool = False
    user_agent: str = f"condev-monitor-python/{SDK_VERSION}"


class _QueuedEvent:
    __slots__ = ("payload",)

    def __init__(self, payload: dict[str, Any]) -> None:
        self.payload = payload


class _FlushRequest:
    __slots__ = ("done",)

    def __init__(self) -> None:
        self.done = threading.Event()


class _ShutdownRequest:
    __slots__ = ()


def parse_dsn(dsn: str) -> ParsedDsn:
    parsed = urlparse(dsn)
    if not parsed.scheme or not parsed.netloc:
        raise ValueError(f"Invalid DSN: {dsn!r}")

    path = parsed.path.rstrip("/")
    parts = [part for part in path.split("/") if part]

    app_id: str | None = None
    if "tracking" in parts:
        tracking_index = parts.index("tracking")
        if tracking_index + 1 >= len(parts):
            raise ValueError("Tracking DSN must include an app id")
        app_id = parts[tracking_index + 1]
        ingest_path = "/" + "/".join(parts[: tracking_index + 2])
    elif parts[-2:] == ["api", "track"]:
        ingest_path = path or "/api/track"
    else:
        ingest_path = f"{path}/api/track" if path else "/api/track"

    normalized = parsed._replace(path=ingest_path, params="", fragment="")
    return ParsedDsn(app_id=app_id, ingest_url=urlunparse(normalized))


def resolve_ingest_url(dsn: str) -> str:
    return parse_dsn(dsn).ingest_url


def _json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if isinstance(value, Mapping):
        return {str(key): _json_safe(item) for key, item in value.items() if item is not None}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_json_safe(item) for item in value]

    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        try:
            return _json_safe(model_dump())
        except Exception:
            pass

    as_dict = getattr(value, "dict", None)
    if callable(as_dict):
        try:
            return _json_safe(as_dict())
        except Exception:
            pass

    isoformat = getattr(value, "isoformat", None)
    if callable(isoformat):
        try:
            return isoformat()
        except Exception:
            pass

    try:
        return _json_safe(vars(value))
    except TypeError:
        return repr(value)


def _compact_mapping(payload: Mapping[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in payload.items() if value is not None}


class CondevReporter:
    def __init__(self, options: ReporterOptions | str, **kwargs: Any) -> None:
        if isinstance(options, ReporterOptions):
            self._options = options
        else:
            self._options = ReporterOptions(dsn=options, **kwargs)

        self._parsed = parse_dsn(self._options.dsn)
        self._max_batch_size = max(1, min(self._options.max_batch_size, 100))
        self._queue: queue.Queue[object] = queue.Queue(maxsize=max(0, self._options.max_queue_size))
        self._lock = threading.Lock()
        self._closed = False

        self._client = httpx.Client(
            timeout=self._options.timeout,
            headers={
                "Content-Type": "application/json",
                "User-Agent": self._options.user_agent,
                "X-Condev-DSN": self._options.dsn,
            },
        )
        self._worker = threading.Thread(
            target=self._run,
            name="condev-monitor-reporter",
            daemon=True,
        )
        self._worker.start()

    @property
    def ingest_url(self) -> str:
        return self._parsed.ingest_url

    @property
    def app_id(self) -> str | None:
        return self._parsed.app_id

    def send(self, event: Mapping[str, Any]) -> None:
        with self._lock:
            if self._closed:
                raise RuntimeError("CondevReporter is already shut down")
        self._queue.put(_QueuedEvent(self._prepare_event(event)))

    def flush(self, timeout: float | None = None) -> None:
        request = _FlushRequest()
        self._queue.put(request)
        if not request.done.wait(timeout):
            raise TimeoutError("Timed out while flushing CondevReporter")

    def shutdown(self, timeout: float | None = None) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True

        self.flush(timeout=timeout)
        self._queue.put(_ShutdownRequest())
        self._worker.join(timeout)
        if self._worker.is_alive():
            raise TimeoutError("Timed out while stopping CondevReporter")
        self._client.close()

    close = shutdown

    def __enter__(self) -> "CondevReporter":
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> bool:
        self.shutdown()
        return False

    def _prepare_event(self, event: Mapping[str, Any]) -> dict[str, Any]:
        payload = _compact_mapping({str(key): _json_safe(value) for key, value in dict(event).items()})
        payload.setdefault("source", "python-sdk")
        payload.setdefault("sdk_version", SDK_VERSION)
        payload.setdefault("_clientCreatedAt", int(time.time() * 1000))
        if self._parsed.app_id and "appId" not in payload:
            payload["appId"] = self._parsed.app_id
        return payload

    def _run(self) -> None:
        batch: list[dict[str, Any]] = []

        while True:
            try:
                item = self._queue.get(timeout=self._options.flush_interval if batch else None)
            except queue.Empty:
                self._flush_batch(batch)
                batch.clear()
                continue

            if isinstance(item, _QueuedEvent):
                batch.append(item.payload)
                if len(batch) >= self._max_batch_size:
                    self._flush_batch(batch)
                    batch.clear()
                continue

            if isinstance(item, _FlushRequest):
                self._flush_batch(batch)
                batch.clear()
                item.done.set()
                continue

            if isinstance(item, _ShutdownRequest):
                self._flush_batch(batch)
                batch.clear()
                return

    def _flush_batch(self, batch: list[dict[str, Any]]) -> None:
        if not batch:
            return
        self._send_batch(batch[:])

    def _send_batch(self, batch: list[dict[str, Any]]) -> None:
        delay = self._options.backoff_base

        for attempt in range(1, self._options.retries + 1):
            try:
                response = self._client.post(self._parsed.ingest_url, json=batch)
                if response.is_success:
                    if self._options.debug:
                        _LOGGER.debug("sent %s events to %s", len(batch), self._parsed.ingest_url)
                    return

                should_retry = response.status_code == 429 or 500 <= response.status_code < 600
                if not should_retry or attempt == self._options.retries:
                    _LOGGER.warning(
                        "dropping %s Condev events after HTTP %s from %s",
                        len(batch),
                        response.status_code,
                        self._parsed.ingest_url,
                    )
                    return
            except httpx.HTTPError as exc:
                if attempt == self._options.retries:
                    _LOGGER.warning(
                        "dropping %s Condev events after transport error: %s",
                        len(batch),
                        exc,
                    )
                    return

            time.sleep(delay)
            delay *= 2.0