# Observability as code (Dash0)

Everything here goes through the same PR + Gitar review as the app.

| File | What | Apply |
|---|---|---|
| `dash0/dashboard.yaml` | "LeadGuard: conference health": check-ins per desk, scans per booth, scan→synced p95, device queues, anomalies by kind, scan outcomes, ingest error ratio, latency by route, desk not-found | `dash0 apply -f observability/dash0/` |
| `dash0/check-rules.yaml` | Alerts: booth went silent, scan sync lag (SLO 30 s), ingest errors, check-in slow (SLO 2 s), lead integrity anomalies, desk can't find people | same |
| `dash0/slos.yaml` | SLOs: 99.9% of scans stored; 99.5% of ingest writes succeed | same |
| `dash0/synthetic-checks.yaml` | `/readyz` and `/api/booths/health` every minute  | same |

`dash0/dashboard.yaml` is generated: edit `dash0/gen_dashboard.py` and re-run it.

**Before applying, run every query against real data**: `python3 observability/check.py http://<prometheus>` (on Civo:
`kubectl -n monitoring port-forward svc/prometheus-server 19090:80`, then `http://127.0.0.1:19090`). It translates Dash0's
metric names (unit suffix, `service_name`) to the in-cluster Prometheus's (SDK exporter, `pod`). EMPTY means the query
works but there's no matching traffic right now (for example no 5xx, which is good); ERROR means the PromQL is broken.

Verify on site with the Dash0 trial: the metric naming (`http_server_request_duration_seconds_*`, `service_name`) follows
Dash0's own examples; check one query in Dash0's explorer before `apply`.

## Applied (Dash0 org in us-west-2, dataset `default`)

`dash0 apply -f observability/dash0/<file> --dataset default` (CLI v1.20.0, token from a file outside the repo):

- the dashboard "LeadGuard: conference health";
- 6 check rules;
- 2 SLOs. Dash0 accepts 28-day (not 1-day or 7-day) SLO windows.

The synthetic checks wait for the public team URL. Verified in Dash0: `leadguard_scans_total`,
`http_server_request_duration_seconds_count{service_name="leadguard-ingest"}`, `{otel_metric_name="leadguard.scans"}`
and the sync-lag histogram all return live data.
