#!/usr/bin/env bash
# Copy LeadGuard's secrets from the Civo stand-in cluster to the Radar team cluster.
# Values stream VM -> laptop -> Radar API through a pipe: never printed, never written to disk.
#   KUBECONFIG_RADAR=~/.config/leadguard/radar-kubeconfig scripts/copy-secrets-to-radar.sh
set -euo pipefail
KC=${KUBECONFIG_RADAR:-$HOME/.config/leadguard/radar-kubeconfig}
NS=${NS:-team-shivaysree}
SSH=(ssh -i ~/.ssh/civo_bench_ed25519 ubuntu@74.220.20.136)
for s in es-credentials otlp-backend app-credentials nebius-credentials dash0-credentials; do
  "${SSH[@]}" "PATH=\$HOME/bin:\$PATH kubectl --context kind-overflow -n team-overflow get secret $s -o json" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); m=d['metadata']; d['metadata']={'name':m['name'],'namespace':'$NS'}; [d.pop(k,None) for k in ('status',)]; print(json.dumps(d))" \
    | kubectl --kubeconfig "$KC" apply -f - | sed 's/^/  /'
done
