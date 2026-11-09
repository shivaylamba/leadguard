# Kubernetes conventions (Radar hackathon cluster)

The team cluster enforces a quota and refuses some pod settings. Flag changes in `deploy/` that would leave pods Pending:

- Every container sets CPU and memory requests and limits. Total requests across the namespace must stay under 2 CPU and 4 GiB (see the table in `plan.md`).
- No `privileged`, `hostPath`, `hostNetwork` or `hostPID`. eBPF agents belong in `kiosk/` (laptop), never in `deploy/`.
- No Services of type LoadBalancer or NodePort in `deploy/` (`local/` is Civo-only and is fine).
- Keep Service `app` on port 80: the team URL routes to it.
- Secrets are referenced by name only (`es-credentials`, `otlp-backend`, `app-credentials`). Flag any literal key, token or password in the diff: the repo and image are public.
- `checkin` stays an Argo Rollout with the `checkin-health` analysis step; changing it to a Deployment needs a reason in the PR.
- Containers run as non-root with `allowPrivilegeEscalation: false` and all capabilities dropped.
