# Condev Animation RUM contract

This zero-dependency package is the canonical normalized wire contract for Animation RUM v2. It is intentionally separate from the Browser collector, DSN transport wrapper, Kafka envelope, storage schema, and dashboard so every trust boundary can reuse one closed metric registry and one validator without copying protocol logic.

The first release is contract-only. Nothing imports it from the production SDK or backend yet, no v2 report is sent or accepted, and Animation RUM v1 remains unchanged.

## Evidence boundary

A normalized v2 report contains only bounded aggregate metrics and closed enums. It never accepts selectors, element IDs or classes, DOM text, input values, URLs, resource names, coordinates, raw events or frames, keyframes, shader source, component or owner labels, source files, props, state, arbitrary metadata, or adapter error text.

Target backing-store size and effective pixel ratio use registry-defined buckets rather than exact geometry. `providerEvidence` is separated by provider and metric family; its counts describe usable provider observations, not necessarily the event population represented by a metric. A supported zero-event count still needs one usable provider-window observation and may then report `value: 0, samples: 0`.

Page captures have no parent or target key. Browser-window metrics use `page-window`; an explicitly installed page renderer or interaction provider may use `adapter`. Target captures require a separate capture ID, a parent page capture ID, and a caller-supplied static semantic `targetKey`. A target key must never be generated from or hash a selector, DOM path, ID, class, text, URL, user, order, session, tenant, timestamp, or random UUID. Shape validation rejects obvious dynamic identifiers but cannot prove that every valid route or target token is low-cardinality; the DSN integration must later require authenticated control-plane registration and application-level cardinality limits for both route templates and target keys. Parent ownership and route/release/environment matching are also server-side checks.

Evidence relation belongs to each metric:

- `target-direct` means a bounded standards API inspected the selected target or subtree.
- `target-temporal-overlap` means a page signal overlapped the selected time window; it does not prove that the target caused the signal.
- `adapter` means an explicit provider supplied a metric allowed by the registry; public DSN data remains client-attested rather than server-verified causality.

Single-capture evidence is always runtime observation. Field measurement is a server-side aggregate claim that requires population, time-window, release, sampling, and minimum-sample rules; clients cannot upload that claim.

Registry membership reserves a stable identity and its evidence rules; it does not claim that the current Browser collector implements that provider. A producer must emit `not-instrumented`, `unsupported`, `unknown`, or `not-observed` until it has the required finite evidence.

## Deployment order

The safe rollout order is contract package, v2 storage schema, Worker consumer/writer, DSN ingress/writer, Monitor API, dashboard, and only then an explicit SDK canary. The SDK must never double-send v1 and v2. A v2 Browser producer must not ship while an older DSN or Worker can silently reject or misroute it.
