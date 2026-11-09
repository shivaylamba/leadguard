#!/usr/bin/env bash
# Reset LeadGuard's data between demo runs: drops check-ins, scans, leads, anomalies, drafts, signals
# and walk-ups, reloads the synthetic attendees and booths. Works on any cluster (Civo or Radar):
# it runs `node src/seed.js --reset` with the app's own image and credentials.
#   scripts/demo-reset.sh --yes [--context kind-overflow] [--namespace team-overflow] [--keep-traffic]
set -euo pipefail
CTX="" NS="team-overflow" YES="" KEEP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) YES=1 ;; --context) CTX="--context $2"; shift ;; --namespace) NS="$2"; shift ;; --keep-traffic) KEEP=1 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac; shift
done
[ -n "$YES" ] || { echo "This deletes all LeadGuard event data in namespace $NS. Re-run with --yes." >&2; exit 1; }
k() { kubectl $CTX -n "$NS" "$@"; }

# 1. Stop rehearsal traffic so it doesn't write into the fresh indices (Civo only).
k get deploy dry-run >/dev/null 2>&1 && k scale deploy/dry-run --replicas=0 >/dev/null && echo "▸ dry-run traffic paused"

# 2. Reset with the app's own image and Secrets.
IMG=$(k get deploy app -o jsonpath='{.spec.template.spec.containers[0].image}')
k delete pod demo-reset --ignore-not-found >/dev/null
k run demo-reset --image="$IMG" --restart=Never --overrides "$(cat <<JSON
{"spec":{"containers":[{"name":"demo-reset","image":"$IMG","command":["node","src/seed.js","--reset"],
 "env":[{"name":"OTEL_SDK_DISABLED","value":"true"},{"name":"ES_REQUEST_TIMEOUT_MS","value":"300000"},
  {"name":"ES_URL","valueFrom":{"secretKeyRef":{"name":"es-credentials","key":"url"}}},
  {"name":"ES_API_KEY","valueFrom":{"secretKeyRef":{"name":"es-credentials","key":"api-key","optional":true}}},
  {"name":"SEMANTIC_INFERENCE_ID","valueFrom":{"secretKeyRef":{"name":"es-credentials","key":"semantic-inference-id","optional":true}}}],
 "resources":{"requests":{"cpu":"50m","memory":"128Mi"},"limits":{"cpu":"500m","memory":"256Mi"}},
 "securityContext":{"runAsNonRoot":true,"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]},"seccompProfile":{"type":"RuntimeDefault"}}}]}}
JSON
)" >/dev/null
k wait --for=jsonpath='{.status.phase}'=Succeeded pod/demo-reset --timeout=300s >/dev/null
k logs demo-reset | tail -1
k delete pod demo-reset >/dev/null

# 3. Fresh state everywhere: the integrity worker and scanners start clean.
k rollout restart deploy/integrity >/dev/null && echo "▸ integrity worker restarted"
[ -n "$KEEP" ] && k get deploy dry-run >/dev/null 2>&1 && k scale deploy/dry-run --replicas=1 >/dev/null && echo "▸ dry-run traffic resumed"
echo "✓ reset. Booth scanners: clear the app's queue only if a phone still holds scans from the last run."
