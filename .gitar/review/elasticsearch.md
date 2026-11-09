# Elasticsearch conventions

Elasticsearch is the only data store (Elasticsearch track). Review queries and mappings for:

- Query builders and detectors live in `app/src/model.js` as pure functions with unit tests. Flag non-trivial queries built inline in route handlers.
- Non-scoring conditions (time windows, booleans, ids) go in `bool.filter`, not `must`.
- No leading wildcards, no `match_all` on user-facing paths, and every search sets a bounded `size`.
- One aggregation or `mget` instead of a query per item: flag any loop that calls `es().search`/`get` per booth, badge or scan (N+1).
- Writes that must be idempotent stay idempotent: scans use `create` with `_id = scan_id`, leads use `booth:badge` ids, anomalies use `anomalyId()`.
- `checked_in` must stay a lookup-mode index: the integrity ES|QL `LOOKUP JOIN` depends on it.
- Never return `notes_semantic` (embedding chunks) to the client: exclude it in `_source`.
- Mapping changes go in `app/src/seed.js`, must stay idempotent, and must say in the PR whether existing indices need `--reset` (that drops check-ins and leads).
- Semantic search must degrade to keyword search when `SEMANTIC_INFERENCE_ID` is unset, and the response's `mode` must say which ran.
