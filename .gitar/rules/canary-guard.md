# Keep the check-in canary

When a pull request changes files under `deploy/` and the diff modifies or removes `deploy/checkin.yaml` or `deploy/analysis-template.yaml`:
- add the label `needs-canary-review`
- comment explaining that `checkin` must stay an Argo Rollout whose steps include the `checkin-health` analysis, and ask the author to confirm the canary still runs.
