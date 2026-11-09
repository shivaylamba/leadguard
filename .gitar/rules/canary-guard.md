# Keep the ingest canary

When a pull request modifies or removes `deploy/ingest.yaml` or `deploy/analysis-template.yaml`:
- add the label `needs-canary-review`
- comment that `ingest` must stay an Argo Rollout whose steps include the `ingest-health` analysis, scoped to the canary's own pods, and ask the author to confirm the canary still runs.
