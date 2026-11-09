# Elasticsearch conventions

Elasticsearch is the only data store (Elasticsearch track). Review queries and mappings for:

- Query builders live in `app/src/queries.js` as pure functions with unit tests. Flag queries built inline in route handlers.
- Non-scoring conditions (time windows, booleans, ids) go in `bool.filter`, not `must`.
- No leading wildcards, no `match_all` on user-facing paths, and every search sets a bounded `size`.
- One aggregation instead of a query per item: flag any loop that calls `es().search` per room, session or result (N+1).
- Never return `abstract_semantic` (embedding chunks) to the client: exclude it in `_source`.
- Mapping changes go in `app/src/ingest.js`, must stay idempotent, and must say in the PR whether existing indices need `--reset` (that drops check-ins).
- Semantic search must degrade to keyword search when `SEMANTIC_INFERENCE_ID` is unset, and the response's `mode` must say which ran.
