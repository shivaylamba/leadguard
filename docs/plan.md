# Overflow: "Room full? Here's the talk next door."

**Cloud Native Hackathon (WeMakeDevs), Salt Lake City, Mon 9 Nov 2026.**
Target: all four sponsor tracks (Sonar/Gitar, Dash0, Radar, Elasticsearch), Merge Forward, and Best Overall.

---

## 1. The idea in one paragraph

At KubeCon the best talks fill up. You walk across the Salt Palace, the door volunteer says "room's full", and you lose the slot.

**Overflow** is a conference companion with two halves:
- **Attendees** check in to a room by scanning the QR code on its door.
- **Organizers** see live room occupancy.

When a room fills, every attendee heading there instantly gets the **most similar talk starting now in a room with seats**, filtered by their accessibility needs. It works in their own language.

Search is hybrid (keyword + semantic, multilingual) over the real schedule in Elasticsearch. Every request, query and check-in is observed end to end with OpenTelemetry in Dash0, down to the kernel via eBPF on the door kiosks. The app runs on Kubernetes through Argo CD with a canary-gated check-in service, operated with Radar and an AI SRE. Every change is reviewed by Gitar.

Pitch line: **"No one should miss the talk they came for, and no one should be the reason a door gets blocked."**

### Why this wins

| Judge question (cross-track) | Our answer |
|---|---|
| Does it make conferences easier? | Yes, for three people at once: the attendee (finds a seat), the volunteer (stops turning people away blindly) and the organizer (sees the building live) |
| Merge Forward (inclusive, accessible) | Accessibility-aware recommendations (step-free route, captions, quiet rooms, low-crowd rooms for sensory needs), multilingual search, screen-reader-first UI, and no account and no badge scan, so it's anonymous by default |
| Real, not a toy | Uses the real KubeCon NA 2026 schedule and real Salt Palace rooms. The traffic is generated live by attendees in the room during the demo |

---

## 2. Track rules → how Overflow scores (verified against the hackathon pages)

### Track 1: Sonar / Gitar, "Never Merge Broken" ($4,000)

**Rules** (from the site):
- Gitar is installed as a GitHub App, and every feature ships as a PR.
- Conventions are written as review instructions in `.gitar/review/`.
- Repository rules cover repeatable workflow actions.
- Auto-apply is on, so Gitar diagnoses failing CI and pushes the fix.
- Judges want Gitar to be *how you built it*, not one PR at the end.

**Our plan:**
- **From minute one:** Gitar installed (14-day Pro trial), branch protection on `main`, and every change goes through a PR. Target: 12 or more PRs during the day.
- **Review instructions** in `.gitar/review/` (format verified: Markdown files, `@path` includes allowed):
  - `otel.md`: OTel semantic conventions; span names `<verb> <resource>`; no PII in attributes (badge and device ids must be hashed); every new HTTP route must set `conference.*` attributes.
  - `elasticsearch.md`: no leading wildcards, non-scoring clauses in `filter`, bounded `size`, no `match_all` in user paths, `semantic_text` for meaning fields.
  - `kubernetes.md`:
    - every container sets requests/limits within the team quota (2 CPU / 4 GiB requests);
    - nothing privileged and no hostPath/hostNetwork/hostPID, because the Radar host refuses them;
    - keep Service `app:80` intact.
  - `accessibility.md`: labelled controls, 4.5:1 contrast, keyboard paths, `alt` text, no colour-only status.
- **Repository rules** in `.gitar/rules/` (natural-language automations; check the syntax in docs.gitar.ai/features/rules):
  - A PR touching `checkin/` or `deploy/rollout*` must include or keep the canary `Rollout` and `AnalysisTemplate`; otherwise label it `needs-canary` and comment.
  - A PR adding an Express route without a span attribute or test gets a comment with the expected snippet.
  - A PR changing an ES mapping must bump `mappings/VERSION` and add a reindex note.
- **Auto-apply** in `.gitar/config/apply.md`: auto-apply CI fixes for lint, typecheck, unit tests and kubeconform failures; never for `deploy/` secrets.
- **CI** (GitHub Actions, on every PR): `npm ci && npm run lint && npm test`, `kubeconform deploy/`, `axe` accessibility smoke on the built UI, and an OTel attribute-name check (grep or Weaver if time).
- **Demo evidence:** one real CI failure (it will happen) diagnosed by Gitar, with an auto-applied fix commit. Also one Gitar review comment that cited our own `.gitar/review/otel.md` rule and caught a real issue (e.g. a raw device id in a span attribute).

### Track 2: Dash0, "Stop Flying Blind" ($4,000)

**Rules:**
- **Must use** Agent0 and the Dash0 MCP server.
- **Bonus:** Dash0 CLI, dashboards, alerts, synthetic monitoring.
- **Steps:** OTel auto-instrumentation in the first hour; ask Agent0 for a root cause and have it open the fix PR; connect the MCP server to the coding agent so it reads live traces and logs.
- **Judging:** depth of instrumentation, observability as part of the product, and a dashboard or SLO showing app health.

**Verified facts:**
- MCP is `https://api.<region>.<cloud>.dash0.com/mcp`, with OAuth or `Authorization: Bearer <token>`.
- Over MCP, Agent0 is read-only. The **fix PR comes from Agent0's GitHub integration in Dash0** ("Reads code, PRs, commits, CI. Writes pull requests").

**Our plan, as instrumentation depth in five layers.** This borrows the layering from Ekansh's Backstage rig and the eBPF signals from the Obs Day rig.

| Layer | How | What it adds |
|---|---|---|
| 0 Kernel (edge kiosk) | OBI v1.0 + OTel eBPF profiler on the door-kiosk box (laptop, Docker) | Zero-code RED for the kiosk, network flows with addresses/ports, CPU profiles per PID → **"threat signals"** (new port, new peer, new hot function) |
| 1 Runtime | `NODE_OPTIONS=--require @opentelemetry/auto-instrumentations-node/register` on every Node service | HTTP/Express/ES client spans, logs with trace ids, runtime metrics |
| 2 Product | Custom spans and attributes: `conference.room.id`, `conference.session.id`, `search.mode`, `search.results.count`, `overflow.recommendations.count` | Business meaning on every span |
| 3 User (RUM) | Browser OTLP/JSON log module (port of `OtlpAnalytics.ts` from the Backstage rig) → Collector with CORS; or the Dash0 website-monitoring guide if quicker | Search typed, zero results, recommendation accepted, check-in from phone |
| 4 Derived | In-cluster OTel Collector (Deployment, not DaemonSet): `transform` (hash ids, add `conference.room.id` from the route), `span_metrics` (RED per route and room), `count` connector (check-ins, zero-result searches, overflow redirects), `k8sattributes` | Product metrics no code emits; correlation to pods and rollout hashes |

**Dash0 assets:**
- **Dashboard "Conference health":** check-ins per minute by room, room occupancy vs capacity, search p95 by mode, zero-result rate, overflow redirects, error rate per rollout hash, and kiosk threat signals.
- **SLOs:**
  - check-in availability ≥ 99.5%;
  - check-in p95 < 300 ms;
  - search p95 < 800 ms.
- **Alert:** zero-result rate > 20% over 10 min. That is a product alert: "attendees can't find talks".
- **Synthetic check:** `GET /api/search?q=ebpf` every minute from Dash0.
- **CLI:** use the Dash0 CLI to apply the dashboard, SLO and check definitions from the repo (`observability/dash0/`), so they go through Gitar review too.

**MCP:** connect the coding agent (Claude Code) to Dash0 MCP at the start. Every bug is debugged by asking "what do the traces say" before reading code.

**Agent0 moment** (real, not staged): ship the obvious first version of occupancy, one ES query per room in a loop. Under load, the organizer view gets slow. Ask Agent0: *"Why is /api/rooms/occupancy slow?"* It should find N ES spans per request (the N+1). Have Agent0 open the PR that replaces the loop with one `terms` + `sum` aggregation. Show the before/after p95 on the dashboard. If Agent0 finds something different and real, use that instead. Never inject a bug.

**Profiles:** Dash0 lists profiles as a supported signal. **Verify on site** that the eBPF profiler's OTLP profiles land in Dash0. Fallback: keep profiles in local Pyroscope and send the *derived* threat-signal log records to Dash0.

### Track 3: Radar, "AI SRE" ($4,000)

**Judges look for** (from the starter README):
1. Run on Kubernetes with Radar connected.
2. Use Radar's UI and MCP throughout building and operating.
3. Run a Radar **AI investigation** on a real issue or question, and show what you learned and did.
4. Make conferences easier.

"One real decision Radar helped you make is enough. More features don't score higher; don't break things on purpose."

**Constraints of the provided cluster** (verified from the starter):
- vcluster, cluster-admin;
- Argo CD and Argo Rollouts, Prometheus (`monitoring/prometheus-server`, scrapes annotated pods, 7 days) and CloudNativePG are preinstalled;
- URL `https://<team>.cnh.radarhq.io` → Service `app:80`;
- budget 2 CPU / 4 GiB requests (4 CPU / 8 GiB limits) and 4 PVCs;
- **privileged pods, hostPath, hostNetwork and hostPID are refused.** So OBI and the eBPF profiler **cannot** run in this cluster. They run on the edge kiosk instead (section 5).

**Our plan:**
- **Setup:** copy `skyhook-io/cnh-starter`, run `./scripts/setup.sh <team>`, apply `argocd/application.yaml` through Radar MCP. Every push to `main` deploys through Argo CD.
- **"Before" Checks screenshot** in the first hour; "after" at 5:00.
- **Release safety:**
  - `checkin` runs as an **Argo Rollout canary** (starter `examples/canary`), with an `AnalysisTemplate` on in-cluster Prometheus.
  - The analysis is scoped to the canary's own pods via `rollouts_pod_template_hash`: the exact pattern from the ArgoCon talk, and it explains why a service-wide SLO misses a canary regression.
  - The agent ships with Radar MCP: `apply_resource`, then `wait_for` the rollout, then check `issues`.
- **Operate with Radar:** Topology, the workload Timeline with diffs, and Metrics (requests sizing: `get_rightsizing` is a natural one given the 2-CPU budget).
- **AI investigation:**
  - **Primary:** run Radar's **Investigate** on whatever actually goes wrong. Likely candidates on a tight quota: the ingest Job OOMs on embeddings, the ES client crashes on missing env, or a Pending pod from `exceeded quota`.
  - **Fallback** if nothing breaks: investigate the app after a release ("is checkin healthy after v3?"). The starter says the all-clear with evidence counts.
- **Our own AI SRE in the product (differentiator):** the organizer console has an **"Ask ops"** panel backed by **AURA + Kimi K3.1 Pro on Nebius Token Factory**, the same AI SRE as the ArgoCon talk.
  - **MCP tools:** Dash0 MCP (Bearer token), Elasticsearch (Agent Builder MCP or the REST API wrapped as a small MCP), and Radar MCP if a non-OAuth token is possible (**verify**; otherwise AURA reads in-cluster Prometheus and Radar is used by the coding agent).
  - **Example:** a volunteer types "Why is check-in slow at 251 A-C?" AURA answers with the trace, the room's occupancy and the pod state, and suggests the action, with policy-gated writes (HITL), the same guardrails as the talk.
  - **Story for judges:** Radar's AI investigation helped *us* run the platform, and AURA helps *organizers* run the conference.
- **5:30 story:** drafted with the starter's `demo-story` skill from Radar's timeline, the investigation and Checks before/after.

### Track 4: Elasticsearch, "Find the Right Talk" ($4,000)

**Rules:**
- Elasticsearch is the core data layer, not a side feature.
- Use keyword, semantic, vector or hybrid search meaningfully.
- Use the **Elastic Agent Skills**.
- Available: Jina embeddings with Cloud, aggregations, dashboards, Workflows, and Agent Builder with MCP.

**Our plan:** Elasticsearch Serverless (free trial at `ela.st/hack-kubecon`, Elasticsearch project type) holds **all** state. There is no other database:
- the schedule;
- rooms (with geo);
- check-ins (time series);
- user preferences (anonymous);
- search analytics;
- threat signals from the kiosks.

**Search** is hybrid with an RRF retriever: BM25 `multi_match` over title, speakers and tags, plus a `semantic` query on `abstract_semantic` (`semantic_text` with a multilingual Jina endpoint). It also handles:
- **Query in Spanish or Hindi, find English talks:** demo it live.
- **"More like this, starting now, with seats":** the overflow recommender. It takes the semantic similarity of the full room's session and filters on time window, room occupancy below capacity and accessibility constraints.
- **Geo:** rooms have `geo_point` (Salt Palace floor plan coordinates); "closest room with a seat" sorts by `geo_distance` from the full room.
- **Time series:** the `checkins` data stream, with ES|QL for live occupancy and trends.
- **Agent Skills in the coding agent:** `elasticsearch-onboarding`, `elasticsearch-index-design`, `elasticsearch-ingest`, `elasticsearch-esql`, `elasticsearch-search-relevance` (query rules to pin keynotes), `elasticsearch-query-optimization` (use it on the Agent0-found slow query), `kibana-dashboards`.
- **Agent Builder:** expose an "Overflow agent" (find talks, occupancy) over MCP. It's what AURA calls for conference data.
- **Search analytics:** every query is logged to the `queries` index; zero-result queries feed both a Kibana panel and the Dash0 alert ("what are attendees looking for that we don't have?").

### Merge Forward: "Conferences for Everyone" (iPad)

- Accessibility profile, stored locally and sent as filters:
  - step-free only;
  - captions or recorded;
  - sensory-friendly (avoid rooms above 85% occupancy);
  - language preference;
  - large text / high contrast.
- Multilingual semantic search, plus "explain this talk in plain language" (a one-paragraph summary generated at ingest and stored in ES).
- No login, no badge scan: anonymous device id, hashed in telemetry (enforced by Gitar rule `otel.md`).
- Screen-reader-first UI (semantic HTML, `aria-live` for "room full" updates); CI runs `axe` on every PR.

---

## 3. Product scope

### Must ship (MVP, by about 13:00)

1. Talk search (hybrid) and a session page.
2. Room check-in by QR (`/r/<room>`), and the occupancy counter.
3. Overflow recommendation when a room is at or above 95% capacity.
4. Organizer live view (rooms grid with occupancy).
5. The whole thing deployed by Argo CD on the Radar cluster, OTel into Dash0, every change via Gitar-reviewed PRs.

### Should ship (14:45–16:30)

6. The accessibility profile filters, multilingual demo, and plain-language summaries.
7. The `checkin` canary Rollout with a pod-hash-scoped analysis.
8. The Dash0 dashboard, SLOs, alert and synthetic check; the Agent0 fix PR.
9. The Radar AI investigation; Checks before/after.

### Stretch (16:30–17:15)

10. "Ask ops" (AURA) in the organizer console.
11. The edge kiosk with OBI and the eBPF profiler, with threat signals into Dash0 and ES.
12. A Kibana dashboard and Agent Builder MCP.

---

## 4. Architecture

```
 Attendee phone (PWA)            Volunteer / organizer console
   │ search, scan room QR          │ live rooms, "Ask ops"
   ▼                               ▼
┌──────────────────── Radar vcluster  ns team-<team> (Argo CD syncs main) ───────────────────┐
│  Service app:80 ──► web+api (Node/Express)  ── @elastic/elasticsearch ──► Elastic Serverless │
│                      │  /api/search /api/sessions /api/overflow /api/rooms                   │
│                      └──► checkin (Node)  Argo Rollout canary ─ AnalysisTemplate(Prometheus) │
│  ingest Job (schedule → ES, summaries)                                                        │
│  otel-collector (Deployment) ── transform · span_metrics · count · k8sattributes ──► Dash0    │
│        ▲ OTLP from all pods + browser (CORS)       └─ prometheus exporter ◄── in-cluster Prom │
│  aura-sre (stretch) ── MCP ──► Dash0 MCP · ES Agent Builder MCP · (Radar MCP if token auth)   │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
        ▲ Radar Cloud (UI + MCP) ◄── coding agent (Claude Code + Radar MCP + Dash0 MCP + Elastic skills)
        ▲ GitHub repo ── PRs ── Gitar review / rules / auto-apply ── Actions build → GHCR → deploy: commit

 Edge kiosk (laptop, Docker Desktop: where eBPF is allowed)
   kiosk app (door scanner) + OBI v1.0 (socket_filter flows + RED) + OTel eBPF profiler (20 Hz)
   + detect.py (baseline: ports/peers/hot functions → "threat signal") ──OTLP──► Dash0
                                                                        └─POST──► api → ES `signals`
```

### Services (all Node 22, one repo)

| Service | Kind | Requests / limits | Notes |
|---|---|---|---|
| `web-api` | Deployment, 2 replicas | 200m/256Mi; 500m/512Mi | Serves the SPA and the APIs. Service `app:80` stays pointed here |
| `checkin` | Argo Rollout, 2 replicas | 100m/128Mi; 300m/256Mi | `POST /api/checkin`. Canary 20 → 50 → 100 with analysis |
| `otel-collector` | Deployment, 1 replica | 200m/256Mi; 500m/512Mi | `otel/opentelemetry-collector-contrib`, pinned |
| `ingest` | Job (on demand) | 300m/512Mi; 1/1Gi | Loads schedule and rooms; ES does the embedding via `semantic_text` |
| `aura-sre` | Deployment, 1 replica | 200m/256Mi; 500m/512Mi | Stretch. AURA 0.2.20 image, Kimi via Token Factory key in Secret |

Total requests are about 1.2 CPU / 1.7 GiB, inside the 2 CPU / 4 GiB budget. Elasticsearch is off-cluster (Serverless), so it costs nothing from the quota.

**Secrets** (created by hand in Radar → Resources → Secrets, never in git; the repo and image are public):
- `es-credentials` (`url`, `api-key`)
- `dash0-credentials` (`token`, `otlp-endpoint`)
- `nebius-credentials` (`api-key`, stretch)

---

## 5. Technical specification

### 5.1 Data model (Elasticsearch)

Mappings are designed with the `elasticsearch-index-design` skill and versioned in `mappings/`.

`sessions`:
```json
{
  "mappings": {
    "properties": {
      "session_id":   {"type": "keyword"},
      "title":        {"type": "text", "fields": {"raw": {"type": "keyword"}}},
      "abstract":     {"type": "text", "copy_to": "abstract_semantic"},
      "abstract_semantic": {"type": "semantic_text", "inference_id": "<multilingual jina endpoint: check GET _inference>"},
      "plain_summary": {"type": "text"},
      "speakers":     {"type": "text", "fields": {"raw": {"type": "keyword"}}},
      "track":        {"type": "keyword"},
      "level":        {"type": "keyword"},
      "tags":         {"type": "keyword"},
      "language":     {"type": "keyword"},
      "room_id":      {"type": "keyword"},
      "start":        {"type": "date"},
      "end":          {"type": "date"},
      "captions":     {"type": "boolean"},
      "recorded":     {"type": "boolean"}
    }
  }
}
```

The other indices:

| Index | Fields |
|---|---|
| `rooms` | `room_id`, `name`, `capacity` (integer), `location` (geo_point), `floor`, `step_free` (bool), `quiet_room` (bool), `qr_code` |
| `checkins` (data stream, time series) | `@timestamp`, `room_id`, `session_id`, `device_hash`, `direction` (`in`/`out`), `source` (`phone`/`kiosk`), `trace_id` |
| `prefs` | `device_hash`, `step_free`, `captions`, `sensory_friendly`, `language`, `updated_at` |
| `queries` | `@timestamp`, `q`, `mode`, `results`, `zero_results`, `language`, `trace_id` |
| `signals` | `@timestamp`, `kiosk_id`, `kind` (`new_port`/`new_peer`/`new_hot_function`), `port`, `peer`, `pid`, `process`, `cpu_cores`, `top_function` |

**Schedule data:** pull the KubeCon NA 2026 public schedule. Sched hosts the CNCF schedules: find the event's export, iCal or JSON feed on site, and respect its terms. Fallback: a curated set of about 150 real sessions from the published schedule page. Add room capacities and approximate geo points for the Salt Palace rooms. Mark them approximate in the UI if they aren't official.

### 5.2 Key queries

**Hybrid search** (RRF retriever):
```json
{
  "retriever": { "rrf": { "retrievers": [
    { "standard": { "query": { "multi_match": { "query": "{q}", "fields": ["title^3", "speakers^2", "tags^2", "abstract"] } } } },
    { "standard": { "query": { "semantic": { "field": "abstract_semantic", "query": "{q}" } } } }
  ] } },
  "query_filter_note": "filters (time window, captions, room ids) go in each standard retriever's bool.filter",
  "size": 10
}
```

**Overflow recommender**, `GET /api/overflow?session=<id>&device=<hash>`:
1. Occupancy of the session's room: ES|QL over `checkins` in the last 90 min:
   `FROM checkins | WHERE room_id == ?r AND @timestamp > NOW() - 90 minutes | STATS inside = SUM(CASE(direction == "in", 1, -1))`
   (or a running counter; ES|QL is enough for hackathon volume).
2. If `inside / capacity ≥ 0.95`: run a semantic query with the full session's abstract as the query text. Filter on:
   - `start` within ±15 min of now;
   - `room_id` in the rooms below 85% occupancy (one `terms` aggregation over `checkins`; this is the query Agent0 will likely flag if v1 loops);
   - the device's `prefs` (step_free → rooms with `step_free`, captions → `captions:true`, sensory → occupancy < 70%).
3. Re-rank by `geo_distance` from the full room. Return the top 3 with a reason string ("similar topic · 2 min walk · 40 seats free · captions").

### 5.3 API

| Method and path | Purpose | Span name / key attributes |
|---|---|---|
| `GET /api/search?q=&mode=hybrid\|keyword\|semantic&lang=` | Find talks | `search sessions` · `search.mode`, `search.results.count`, `search.zero_results` |
| `GET /api/sessions/:id` | Session detail + plain summary | `get session` · `conference.session.id` |
| `POST /api/checkin {room_id, direction, device_hash}` | Phone or kiosk check-in (served by `checkin`) | `checkin room` · `conference.room.id` |
| `GET /api/rooms/occupancy` | Organizer grid | `get occupancy` · `conference.rooms.count` |
| `GET /api/overflow?session=&device=` | Recommendations | `recommend overflow` · `overflow.recommendations.count` |
| `PUT /api/prefs` | Accessibility profile | `put prefs` |
| `POST /api/signals` | Edge kiosk threat signal | `ingest signal` · `signal.kind` |
| `POST /api/ops/ask` | "Ask ops" → AURA (stretch) | `ask ops` |
| `GET /healthz`, `GET /readyz` | Probes (keep the starter's contract) | not traced |

### 5.4 OpenTelemetry specification

**Resource attributes** (all services):
- `service.name`: one of `overflow-web-api`, `overflow-checkin`, `overflow-ingest`, `overflow-kiosk`, `overflow-browser`;
- `service.namespace=overflow`, `service.version=<git sha>`, `deployment.environment.name=cnh`;
- k8s attributes are added by the collector (`k8sattributes`, including the pod label `rollouts-pod-template-hash`).

**Spans:**
- Auto-instrumentation covers HTTP and Express. Elasticsearch client spans are emitted natively by `@elastic/elasticsearch` when an OTel SDK is active (**verify** on the client version we pin; otherwise wrap the calls).
- Manual spans: `recommend overflow` with child spans `occupancy lookup`, `semantic candidates`, `geo rerank`.

**Custom attributes** (namespaced, documented in `.gitar/review/otel.md`):
- `conference.room.id`, `conference.session.id`
- `search.mode`, `search.results.count`, `search.zero_results`
- `overflow.recommendations.count`, `overflow.reason`
- `enduser.pseudo_id` (a SHA-256 of the device id; never raw)

**Metrics:**

| Source | Metrics |
|---|---|
| SDK | `conference.checkins` (counter: room, direction), `conference.room.occupancy` (gauge: room) |
| Collector `count` connector, from logs | `overflow.search.zero_results`, `overflow.redirects` |
| Collector `span_metrics` | RED per `http.route`, `conference.room.id`, `k8s.pod.label.rollouts-pod-template-hash` |

**Collector pipeline** (adapted from `eKuG/backstage-demo-na26/rig/collector/config.yaml`):
- `otlp` receiver with CORS for the app origin;
- processors: `k8sattributes`, `transform` (hash `device_hash` if it ever arrives raw, derive `conference.room.id` from `url.path`), `batch`;
- connectors: `span_metrics`, `count`;
- exporters: `otlp` to Dash0 (Bearer token from Secret), plus `prometheus` on :8889 for the in-cluster Prometheus (pod annotated `prometheus.io/scrape: "true"`, `prometheus.io/port: "8889"`). The canary analysis reads this.

**Canary analysis** (`checkin`):
- metric `checkin-error-rate`: `sum(rate(...{http_route="/api/checkin", status=~"5..", rollouts_pod_template_hash="{{args.canary-hash}}"}[1m])) / sum(rate(...{same hash}[1m]))`;
- success below 1%, with a minimum-traffic guard: "inconclusive, never pass", the same answer as for the LinkedIn question.

**The edge kiosk** (`kiosk/`, docker compose, adapted from `eKuG/obs-day-na26/rig`):
- The kiosk app is a tiny Python door-scanner service on :8080 that posts check-ins.
- **OBI v1.0** (`network.source: socket_filter`, `attributes.select` keeping `src.address`, `dst.address`, `server.port`, named CIDRs) gives RED plus flows.
- The **OTel eBPF profiler** (20 Hz, `service.name = <exe>:<pid>`) gives profiles.
- `detect.py` learns a baseline, then emits `signal` records to `/api/signals` and OTLP logs to Dash0.
- **Story:** "a compromised kiosk on venue Wi-Fi is caught without a single rule: new port, new peer, new hot function, all from telemetry you already collect."
- Only demo it with the rig's harmless simulated rogue (`rogue.py`); say so on stage.

### 5.5 Repository layout

```
overflow/                         (from skyhook-io/cnh-starter template, public)
├── AGENTS.md CLAUDE.md           starter + our conventions (Gitar reads these too)
├── .gitar/review/{otel,elasticsearch,kubernetes,accessibility}.md
├── .gitar/rules/*.md   .gitar/config/apply.md
├── .github/workflows/{deploy.yaml (starter), ci.yaml}
├── app/            web-api (Express) + public/ (PWA, vanilla or Preact, no heavy build)
├── checkin/        checkin service
├── ingest/         schedule + rooms loader, mappings/
├── otel/           collector config, tracing bootstrap
├── observability/dash0/   dashboard, SLO, check definitions (applied via Dash0 CLI)
├── deploy/         kustomize: deployment, service, rollout-checkin, analysis-template, collector, job
├── argocd/application.yaml
├── kiosk/          docker-compose: kiosk app, OBI, profiler, detect.py   (laptop only)
└── docs/story.md   5:30 story: Radar timeline, investigation, Checks before/after
```

---

## 6. The day (Mon 9 Nov). Your ArgoCon talk is at 13:30 at the Salt Palace (5 minutes' walk)

| Time | Work | Track evidence produced |
|---|---|---|
| 10:00–11:00 | Breakfast, kickoff, team. **Before coding:** Gitar app installed, Dash0 trial and token, Elastic Serverless project, Radar cluster (`join.cnh.radarhq.io`), Radar MCP + Dash0 MCP added to Claude Code, Elastic Agent Skills installed. Confirm the rules on reusing your own open-source code (AURA, the rigs) | Accounts |
| 11:00–11:30 | Template → `setup.sh` → Argo CD app via Radar MCP. Screenshot of Radar **Checks: "before"**. PR #1: OTel auto-instrumentation + collector → Dash0 (**first hour, per the Dash0 rule**) | Radar, Dash0, Gitar |
| 11:30–12:45 | PRs: ES mappings + ingest Job; hybrid search API + UI; room QR check-in; occupancy grid (naive v1). Each PR goes through Gitar | ES, Gitar |
| 12:45–13:00 | Hand-off: a teammate (or your coding agent with a written task list) continues on the overflow recommender | |
| 13:00–14:45 | **Your ArgoCon talk.** The team keeps shipping PRs (overflow, prefs). If solo, queue well-scoped issues for the agent and review its PRs when back | |
| 14:45–15:30 | Overflow recommender + accessibility filters + multilingual check. Load generator (`k6` or `hey` from a laptop) for real traffic | ES, Merge Forward |
| 15:30–16:15 | Agent0: root cause of slow occupancy → PR → merge → p95 before/after. Dash0 dashboard, SLOs, alert and synthetic check via the CLI | Dash0 |
| 16:15–16:45 | `checkin` canary Rollout + analysis; ship a release through it with Radar `wait_for`. Radar **AI investigation** on the most interesting real issue of the day | Radar |
| 16:45–17:15 | Stretch: "Ask ops" (AURA) or the edge kiosk, **pick one**. Radar Checks "after". Draft the 5:30 story | Radar, Dash0 |
| 17:15–17:30 | Freeze. Rehearse the 3-minute demo twice. Backup screen recording | |

---

## 7. Three-minute demo script

1. **(0:00) The problem, 15 s.** "Room 251 is full. Kelsey's talk. You just walked 10 minutes."
2. **(0:15) Attendee, 45 s.** On a phone:
   - search "ebpf seguridad" (Spanish) → English eBPF talks;
   - scan the room QR → check in;
   - the room flips to *full*, and the recommender offers "the most similar talk starting now, 2 min away, step-free, captions".
3. **(1:00) Organizer, 30 s.** The live room grid turns amber and red, and redirects are counted. Ask ops (if built): "why is check-in slow at 251?" gets an answer with the trace.
4. **(1:30) Dash0, 30 s.** Trace from phone tap → API → ES spans. The dashboard and SLO. "Agent0 found our N+1 and opened this PR; p95 went from X to Y."
5. **(2:00) Radar, 30 s.** Timeline of today's releases, the canary that gated check-in on its own pods, the AI investigation we ran and the decision it led to, and Checks before/after.
6. **(2:30) Gitar, 20 s.** "Every change was a PR: N PRs, our own OTel and accessibility rules, and the CI failure Gitar fixed itself."
7. **(2:50) Close, 10 s.** "No one should miss the talk they came for."

---

## 8. Risks and checks to do on site

| Risk | Mitigation |
|---|---|
| Rules on prior code are unknown (the Rules tab wasn't readable) | Ask at kickoff. Start a fresh repo from the starter; treat AURA and the rigs as open-source dependencies, credited |
| eBPF is impossible in the Radar cluster (privileged/hostPID refused) | Run it on the laptop edge kiosk only; the core app never depends on it |
| Dash0 may not ingest OTLP profiles from the profiler distribution | Send derived threat-signal logs to Dash0; keep the flamegraph in local Pyroscope |
| AURA can't do Radar MCP OAuth | AURA uses Dash0 MCP (Bearer) + ES + in-cluster Prometheus; Radar is used via the coding agent and the UI |
| Schedule data isn't exportable | Curated real subset, entered from the public page, and labelled as such |
| 2 CPU quota | ES is off-cluster; small requests; run `get_rightsizing` in Radar |
| Your talk takes 13:00–14:45 out of the day | MVP done by 12:45; written task list for the teammate or agent; stretch items are optional |
| Nothing breaks, so there's no Radar or Agent0 story | Both tracks accept a real all-clear investigation; never break things on purpose (Radar says so explicitly) |
| Secrets leak in a public repo or image | Secrets only via Radar's Secret UI; add a Gitar review rule "no secrets or keys in diffs"; never paste keys into chat |

## 9. Definition of done (per track)

- [ ] **Gitar:**
  - [ ] at least 12 PRs reviewed;
  - [ ] `.gitar/review` (4 files), `.gitar/rules` (at least 2) and `apply.md` on `main`;
  - [ ] at least 1 auto-applied CI fix;
  - [ ] at least 1 review comment citing our rule.
- [ ] **Dash0:**
  - [ ] traces, logs and metrics from all services and the browser;
  - [ ] the dashboard and 3 SLOs;
  - [ ] the alert and synthetic check;
  - [ ] the MCP used by the coding agent;
  - [ ] an Agent0 root cause and its PR merged, with before/after.
- [ ] **Radar:**
  - [ ] Argo CD deploys every push;
  - [ ] the canary Rollout gated by analysis;
  - [ ] at least 1 AI investigation with findings acted on;
  - [ ] Checks before/after;
  - [ ] the 5:30 story from the timeline.
- [ ] **Elasticsearch:**
  - [ ] all state in ES;
  - [ ] hybrid RRF search, multilingual semantic, geo rerank, ES|QL occupancy;
  - [ ] Agent Skills used (named in the README).
- [ ] **Merge Forward:**
  - [ ] accessibility filters change the recommendation;
  - [ ] multilingual query demoed;
  - [ ] `axe` clean in CI;
  - [ ] no PII anywhere.
- [ ] **Overall:** a phone demo with real people in the room checking in during judging (put the QR on the slide).
