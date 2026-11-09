# OpenTelemetry conventions

Observability is part of the product (Dash0 track). Review every change against these:

- Every new HTTP route or background step creates or annotates a span. Use `inSpan()` / `annotate()` from `app/src/telemetry.js`; don't create tracers elsewhere.
- Span names are `<verb> <thing>` in lowercase (`store scans`, `upsert leads`, `integrity sweep`), never a URL with ids in it.
- Our attributes are namespaced `leadguard.*`: `leadguard.booth.id`, `leadguard.desk.id`, `leadguard.scanner.id`, `leadguard.batch.size`, `leadguard.anomaly.kind`, `leadguard.search.results`. Use OTel semantic-convention names for anything they already cover (`http.*`, `db.*`, `url.*`); don't invent synonyms.
- **No personal data in telemetry**: see `leads-privacy.md`. Badge ids appear only as `enduser.pseudo_id` = `pseudonym(id)`.
- Metric attributes must be low-cardinality: booth, desk, outcome, kind. Never badge ids, queries or timestamps.
- Logs are one JSON object per line with `level` and `msg`.
- Collector changes (`deploy/otel-collector.yaml`): pipelines must keep `memory_limiter` first and `batch` last; nothing may need hostPath, hostNetwork or privileged.
