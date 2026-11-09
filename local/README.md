# local/: stand-ins for the hackathon platform, Civo only

Never synced in the Radar cluster. `local/bootstrap.sh` creates the `overflow` kind cluster on the Civo VM
and installs what the Radar vcluster provides (Argo CD, Argo Rollouts, Gateway API CRDs, Prometheus as
`monitoring/prometheus-server`), plus stand-ins for the accounts we don't have yet:

| Stand-in | Replaced by | Swap |
|---|---|---|
| `elasticsearch` (single node 9.5.6, trial licence for ML inference) | Elastic Serverless | update Secret `es-credentials` (url, api-key, semantic-inference-id) |
| `lgtm` (grafana/otel-lgtm: Tempo, Loki, Prometheus, Grafana) | Dash0 | update Secret `otlp-backend` (endpoint, token, insecure=false) |
| NodePort 30080 → Service app | `https://<team>.cnh.radarhq.io` | nothing: Radar routes to Service app:80 |
