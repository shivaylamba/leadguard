# OpenTelemetry conventions

Observability is part of the product (Dash0 track). Review every change against these:

- Every new HTTP route or background step creates or annotates a span. Use `inSpan()` / `annotate()` from `app/src/telemetry.js`; don't create tracers elsewhere.
- Span names are `<verb> <thing>` in lowercase (`search sessions`, `recommend overflow`), never a URL with ids in it.
- Our attributes are namespaced: `conference.room.id`, `conference.session.id`, `search.mode`, `search.results.count`, `search.zero_results`, `overflow.*`, `signal.kind`. Use OTel semantic-convention names for anything they already cover (`http.*`, `db.*`, `url.*`); don't invent synonyms.
- **No personal data in telemetry.** Device ids are only ever recorded as `enduser.pseudo_id` = `pseudonym(id)`. Flag any span attribute, metric attribute, log field or log message that carries a raw device id, an email, a name, a badge number or free text typed by a user, except the search query in the `queries` index.
- Metric attributes must be low-cardinality: room, mode, direction, status. Never ids, queries or timestamps.
- Logs are one JSON object per line with `level` and `msg`.
- Collector changes (`deploy/otel-collector.yaml`): pipelines must keep `memory_limiter` first and `batch` last; nothing may need hostPath, hostNetwork or privileged.
