from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Iterator

from .reporter import CondevReporter, ReporterOptions


def _iter_events(payload: Any) -> Iterator[dict[str, Any]]:
    if isinstance(payload, dict):
        yield payload
        return
    if isinstance(payload, list):
        for item in payload:
            if isinstance(item, dict):
                yield item


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Forward JSONL AI events from stdin to a Condev DSN.")
    parser.add_argument("--dsn", default=os.getenv("CONDEV_DSN"), help="Condev DSN. Defaults to CONDEV_DSN.")
    parser.add_argument("--debug", action="store_true", help="Enable verbose reporter logging.")
    args = parser.parse_args(argv)

    if not args.dsn:
        parser.error("a DSN is required via --dsn or CONDEV_DSN")

    reporter = CondevReporter(ReporterOptions(dsn=args.dsn, debug=args.debug))
    invalid_lines = 0

    try:
        for line_number, raw_line in enumerate(sys.stdin, start=1):
            line = raw_line.strip()
            if not line:
                continue

            try:
                payload = json.loads(line)
            except json.JSONDecodeError as exc:
                invalid_lines += 1
                print(
                    f"[condev-monitor] invalid JSON on line {line_number}: {exc}",
                    file=sys.stderr,
                )
                continue

            for event in _iter_events(payload):
                reporter.send(event)

        reporter.flush()
    finally:
        reporter.shutdown()

    return 1 if invalid_lines else 0


if __name__ == "__main__":
    raise SystemExit(main())