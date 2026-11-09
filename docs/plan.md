# LeadGuard: check-ins you can trust, leads sponsors can trust

**Cloud Native Hackathon (WeMakeDevs), Salt Lake City, November 2026.**
Target: all four sponsor tracks (Sonar/Gitar, Dash0, Radar, Elasticsearch), plus Merge Forward and Best Overall.
Repo: `github.com/shivaylamba/leadguard`.

---

## 1. The problem, from organizers who lived it

Saiyam's challenge to our first idea: *why would anyone scan an app to enter a room?* Fair. So we went to the people who run conferences, and built for workflows that already exist: **registration check-in** and **sponsor lead scanning**.

From a conference organizer (quoted with their words):

> "Our lead generation system failed, and a sponsor complained that no leads were generated, which compromised their willingness to sponsor us next time."
>
> "People had to be looked up by email, but … someone had purchased their ticket with their work email, then left their job, and was trying to access their ticket with a different email. Some emails had landed in spam, but we didn't realize it."
>
> "These are a lot of systems that could have made the conference more observable, helping to reduce risk at that scale and pressure."

From the ZurichJS Conf 2026 operations audit (an internal document; **get permission before showing numbers on stage**):

| Evidence | What LeadGuard does about it |
|---|---|
| 139 of 204 badges picked up on the day went out **in one hour** | The desk lookup is built for a rush: fuzzy names, any linked email and order ids. Desk throughput is tracked as an SLO |
| **14 door check-in pull requests merged in one day, 9 days before the event** | Every change is Gitar-reviewed against our rules, CI runs a contract test, and the check-in writes ship as a canary. `simulate.js` is the "dry run a month out" they asked for |
| A venue's email sat **in spam for 16 days**; tickets bought with a **work email, then the person changed jobs** | Ticket-email delivery tracking (bounced, spam, never delivered) gives a "tickets at risk" list *before* the desk. The desk finds people by any email, and links the email they use today |
| 49 people picked up the night before and 48 of them skipped the desk | Early pickup is just another desk (`desk_id`); the stats show how much of the rush it absorbed |
| A t-shirt order hit the ticket webhook and was issued a ticket | Roadmap: keep product types apart at the webhook, and flag tickets with no ticket product (the same integrity pattern) |
| Sponsors: the money and the relationship at risk | Lead integrity and booth health, so "you lost our leads" is caught in minutes, with evidence |

**The rule LeadGuard enforces:** a sponsor's leads are a subset of the people who actually checked in. Anything that breaks the rule, or any booth that goes quiet, is shown to the organizer *before* the sponsor complains.

## 2. What it does

| Who | Screen | What they get |
|---|---|---|
| Desk volunteer | `#/desk` | Find a person by name (fuzzy), **any** email ever linked, company, badge or order id. Check them in. Link today's email. See "ticket email bounced" at a glance |
| Booth staff | `#/scan` | Scan badges (typed, or the camera via the browser's BarcodeDetector), with consent and notes. **Works offline**: scans queue on the device and sync idempotently when Wi-Fi returns. A "Simulate Wi-Fi off" switch for demos |
| Organizer | `#/ops` | Check-ins now and per minute, booth health (leads, consent, last lead, scanners, queued scans), open anomalies with plain-language explanations, tickets at risk |
| Sponsor | `#/leads/<booth>` | Their consented leads, notes searchable semantically ("people evaluating OpenTelemetry"), CSV export (consented only) |

**Anomalies** (from `app/src/model.js` and `app/src/integrity.js`, every 30 s):

| Kind | Detection | Typical cause |
|---|---|---|
| `never_checked_in` | ES\|QL `LOOKUP JOIN` of scans against `checked_in` | Shared or forwarded badge, reused printed badge, typo |
| `scanned_before_checkin` | Same join, comparing `scanned_at` with `first_checkin_at` | Scanner clock wrong, badge used before pickup |
| `impossible_travel` | The same badge at two booths faster than 2 m/s (booths are `geo_point`) | Shared or cloned badge |
| `silent_booth` | A booth that scanned in the last hour has had nothing for 10 min (during expo hours, venue time) | Scanner app crashed, battery, Wi-Fi: leads are being lost |
| `scanner_offline` | No heartbeat for 2 min | Device off or offline, so scans may be queued |
| `scans_not_syncing` | Online, but queue depth > 0 for 5 min | Sync failing |

Booth and scanner anomalies clear themselves when fixed; lead anomalies wait for an organizer.

## 3. Track by track: how we win each one

### Sonar / Gitar, "Never Merge Broken"
- **Every change is a PR** with Gitar review. Branch protection on `main` from the start.
- **Review instructions** in `.gitar/review/`:

  | File | Covers |
  |---|---|
  | `time.md` | UTC storage, venue-zone business hours, device clock skew. Their card: time zones |
  | `leads-privacy.md` | Consent, no personal data in telemetry, one export path, webhook auth |
  | `elasticsearch.md` | Idempotent writes, no N+1, lookup index kept |
  | `kubernetes.md` | Radar quota and refused pod settings; the `ingest` canary |
  | `otel.md` | Span and attribute conventions |
  | `accessibility.md` | Accessible UI conventions |

- **Repository rules** in `.gitar/rules/`:
  - `api-contract.md` (their card: the frontend still matches the API, and scanners in the field stay compatible);
  - `canary-guard.md`;
  - `telemetry-for-routes.md`.
- **Auto-apply** in `.gitar/config/apply.md`, for lint, tests (including the API contract test) and kubeconform failures.
- **Demo:** a PR renames a scan field, the contract test fails, and Gitar diagnoses it and pushes the fix. Their card invites breaking CI live; Radar's says don't break things on purpose, so this happens only in the Gitar segment, and we say so on stage.
- **Story:** ZurichJS merged 14 door check-in PRs in a day, 9 days out. This is how you make that safe.

### Dash0, "Stop Flying Blind"
- **Depth, everywhere:**
  - **Scanner PWA:** browser RUM (scan, Wi-Fi toggle, queue depth).
  - **Desk app:** searches, including not-found.
  - **Ingest:** spans for `store scans`, `upsert leads`, the checkin; metrics `leadguard.scans{outcome}`, `leadguard.scan.sync_lag`, `leadguard.scanner.queue_depth`.
  - **Integrity worker:** the `integrity sweep` span; `leadguard.anomalies{kind}`.
  - **Elasticsearch:** client spans.
  - **Collector:** Collector-derived RED per booth and desk, with privacy scrubbing.
  - **Kiosk:** eBPF on the check-in kiosk (OBI flows + profiler + Ekansh's no-rule threat signals).
- **The SLOs are the organizer's promises:**
  - scan → synced lead p95 under 30 s;
  - zero lost leads (scans accepted vs scans queued on devices);
  - check-in p95 under 2 s;
  - desk lookup p95 under 500 ms.
- **Alerts:** booth silent during expo hours; ticket-email bounce spike by domain.
- **Agent0 on a real issue:** a scanner coming back online flushes its whole queue at once, and several at once make a reconnect storm. That's a genuine failure mode, and the simulator's `--offline` flag reproduces it. Ask Agent0 for the root cause and have it open the PR with the fix (batching or jittered backoff). Show p95 before and after.
- **MCP:** Dash0 MCP is connected to the coding agent from the start.
- **CLI:** dashboards, SLOs and checks live in `observability/dash0/` as code, so they go through Gitar review too.
- **LLM tracing:** Aura emits OTel traces for each model and tool call. Add OpenLIT if we add a Python piece.

### Radar, "AI SRE"
- **GitOps:** runs on the Radar cluster through Argo CD (every push deploys).
- **Canary:** `ingest` is a canary Rollout whose analysis is scoped to the canary's own pods (`pod=~"ingest-<hash>-.*"`, OTel `http_server_request_duration_count`), with too little traffic counted as inconclusive, never a pass.
- **One real decision Radar helps us make:** an HPA and right-sizing on `ingest` for the doors-open rush and reconnect storms, within the 2-CPU quota (`get_rightsizing`).
- **AI investigation:** run Radar's investigation on the reconnect-storm slowdown, or the day's first real failure.
- **Checks:** before and after.
- **Aura (the AI SRE from the ArgoCon talk)** as the organizer's ops agent:
  - **The question:** "Sponsor X says they lost leads at 3 pm. What happened?" Aura answers from the evidence: the scanner went offline 14:10–14:55, 31 scans were queued, 31 synced, 0 were lost.
  - **Approvals:** it drafts the sponsor email; anything that emails people waits for approval (the same pattern as the organizer's own tool).

### Elasticsearch, "Find the Right Talk" (here: find the right *person*, and the right *lead*)
- **The one data store:** `attendees`, `checkins` (data stream), `checked_in` (lookup index), `booths` (geo), `scans` (data stream, `_id = scan_id`), `leads`, `scanners`, `anomalies`, `ticket_emails` (data stream), `signals`.
- **Desk search:** fuzzy and prefix names, keyword matches across every linked email, order and badge ids.
- **ES|QL `LOOKUP JOIN`:** the core integrity check.
- **Geo:** impossible travel uses the booths' `geo_point`.
- **Semantic search over lead notes** (`semantic_text`; multilingual E5 locally, Jina on Serverless) for sponsors.
- **Next:**
  - an ML anomaly-detection job on per-booth scan rate (Agent Skill: `elasticsearch-anomaly-detection`);
  - Agent Builder over MCP for Aura and a sponsor assistant;
  - a Kibana dashboard.
- **Agent Skills used:** `elasticsearch-index-design`, `elasticsearch-esql`, `elasticsearch-ingest`, `elasticsearch-anomaly-detection`, `elasticsearch-search-relevance`, `kibana-dashboards`.

### Merge Forward
- **Assisted desk:** a `needs_assistance` flag on the attendee, shown at the desk.
- **Accessible UIs:** keyboard-first, screen-reader-friendly UIs (`aria-live`, no colour-only status), `axe` in CI.
- **Consent:** clear consent at the booth; sponsors only ever see consented contacts.

## 4. Architecture

```
 Desk (phone/laptop)   Booth scanner (PWA, offline queue)   Organizer / Sponsor consoles
        │ lookup, check-in        │ batches + heartbeats              │ reads
        ▼                         ▼                                   ▼
┌───────────────────── Radar vcluster ns team-<team> (Argo CD syncs main) ─────────────────────┐
│ Service app:80 → web (ROLE=web) ──forwards writes──► ingest (ROLE=ingest, Argo Rollout canary) │
│                    │ reads                                │ create scans (_id=scan_id), leads │
│ integrity (ROLE=integrity): ES|QL LOOKUP JOIN · impossible travel · booth health → anomalies  │
│ otel-collector: k8sattributes · privacy scrub · spanmetrics · count ──► Dash0                 │
│ seed Job (PostSync): indices, booths, attendees                                               │
└─────────────────────────────┬────────────────────────────────────────────────────────────────┘
                              ▼
                  Elastic Serverless (the only data store)
 Check-in kiosk (laptop): OBI + eBPF profiler + detect.py → threat signals → Dash0 + /api/signals
 Email provider webhook → /api/email/events (ticket delivered / bounced / spam)
```

**Budget** (requests):

| Service | Requests |
|---|---|
| web ×2 | 150m / 192Mi each |
| ingest ×2 | 100m / 160Mi each |
| integrity ×1 | 50m / 128Mi |
| collector ×1 | 100m / 192Mi |
| **Total** | **about 0.75 CPU / 1.2 GiB**, under the 2 CPU / 4 GiB quota |

## 5. Status: built and running on the Civo stand-in cluster

- `app/`: one Node 22 image with three roles (web, ingest, integrity), plus `seed.js` and `simulate.js`. 14 unit and contract tests.
- `deploy/`: web, ingest Rollout + analysis, integrity, Collector, OTel SDK config, seed hook.
- `local/`: a kind cluster on the Civo VM with Argo CD, Rollouts, Gateway CRDs, Prometheus (`monitoring/prometheus-server`), Elasticsearch 9.5.6 (trial, multilingual E5) and LGTM standing in for Dash0.
- `.gitar/`: review instructions, rules, auto-apply. `.github/workflows/ci.yaml`: lint, tests, kubeconform.

**Swap to the real accounts on the day:**
- **Elastic Serverless:** Secret `es-credentials` (`url`, `api-key`, `semantic-inference-id`).
- **Dash0:** Secret `otlp-backend` (`endpoint`, `token`, `insecure=false`).
- **Gitar:** install the GitHub App.
- **Radar:** `scripts/setup.sh <team>`, then apply `argocd/application.yaml` via Radar MCP.

## 6. Demo (3 minutes, live, with the judges)

1. **(0:00) The quote.** "A sponsor told us no leads were generated, and nearly didn't come back."
2. **(0:20) Desk.** A judge gives a misspelt name or an old work email, and the desk still finds them; we link the email they use today and check them in. "Tickets at risk" shows the people whose ticket email bounced.
3. **(0:50) Booths.** Two of us scan the judges.
   - One badge that never checked in gets scanned: a `never_checked_in` anomaly appears within 30 s, with the reason.
   - Turn on "Wi-Fi off" for one scanner and keep scanning: the scanner goes offline, scans queue, and the booth shows as at risk.
   - Turn Wi-Fi back on: the scans sync, with zero lost.
4. **(1:40) Dash0.** The trace from scan to synced lead, the SLOs, and the Agent0 root cause and PR for the reconnect storm.
5. **(2:10) Radar.** The timeline, the canary that gated `ingest`, the AI investigation and the decision it led to. Aura answers "what happened at the Radar booth?".
6. **(2:35) Gitar.** The contract-break PR fixed by auto-apply, and the time-zone and privacy rules that caught real issues.
7. **(2:50) Close.** "Check-ins you can trust. Leads sponsors can trust."

## 7. Roadmap slide (from the ZurichJS audit)

- **Sponsor deal room:** the package as a checklist, owners, invoice details collected once, deadline reminders, and stalled-after-yes alerts.
- **Shared inbox:** an owner per thread, "unanswered for more than 2 days" alerts, and a daily spam check. This reuses the ticket-email delivery pipeline.
- **Self-serve:** ticket changes, company invoices, speaker expenses with caps and status.
- **CFP:** a second contact at submission (the job-change problem again), and a check that every submission has its reviews (the silent 1,000-row limit).
- **Merch tracker:** ordered, handed out, owed, and sizes.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Real attendee data | Synthetic attendees only (`.example` domains), plus the judges' own consented test badges |
| ZurichJS numbers are internal | Ask the organizer before showing them; otherwise describe them qualitatively |
| eBPF can't run in the Radar cluster | The kiosk runs on a laptop; the core app never depends on it |
| Radar MCP auth for Aura | Aura uses Dash0 MCP + Elasticsearch + in-cluster Prometheus; Radar via the coding agent and UI |
| Nothing breaks during the day | The reconnect storm is real when scanners come back online; otherwise use the all-clear investigation, which Radar accepts |
