#!/usr/bin/env bash
# Create the `overflow` kind cluster on the Civo VM and install what the Radar vcluster
# provides, plus local stand-ins (local/README.md). Idempotent. Run on the VM:
#   ./local/bootstrap.sh
# Leaves the kind-staging / kind-prod demo clusters alone.
set -euo pipefail
cd "$(dirname "$0")/.."
NAME=overflow CTX=kind-overflow TEAM=overflow
ARGOCD=v3.6.1 ROLLOUTS=v1.10.2 GATEWAY=v1.7.0

if ! kind get clusters | grep -qx "$NAME"; then
  cat <<KIND | kind create cluster --name "$NAME" --config -
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    extraPortMappings:
      - { containerPort: 30080, hostPort: 18080, listenAddress: "127.0.0.1" }   # app
      - { containerPort: 30300, hostPort: 13300, listenAddress: "127.0.0.1" }   # Grafana (LGTM)
KIND
fi
k() { kubectl --context "$CTX" "$@"; }

k create namespace argocd --dry-run=client -o yaml | k apply -f -
k apply -n argocd --server-side --force-conflicts -f "https://raw.githubusercontent.com/argoproj/argo-cd/${ARGOCD}/manifests/install.yaml"
k create namespace argo-rollouts --dry-run=client -o yaml | k apply -f -
k apply -n argo-rollouts -f "https://github.com/argoproj/argo-rollouts/releases/download/${ROLLOUTS}/install.yaml"
k apply --server-side -f "https://github.com/kubernetes-sigs/gateway-api/releases/download/${GATEWAY}/standard-install.yaml"
# Like the Radar cluster: Argo CD watches Applications in team-* namespaces, project team-<team>.
k -n argocd patch configmap argocd-cmd-params-cm --type merge -p '{"data":{"application.namespaces":"team-*"}}'
k -n argocd rollout restart deploy/argocd-server statefulset/argocd-application-controller >/dev/null

k create namespace "team-$TEAM" --dry-run=client -o yaml | k apply -f -
cat <<PROJ | k apply -f -
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata: { name: team-$TEAM, namespace: argocd }
spec:
  sourceRepos: ["*"]
  sourceNamespaces: [team-$TEAM]
  destinations: [{ server: https://kubernetes.default.svc, namespace: "*" }]
  clusterResourceWhitelist: [{ group: "*", kind: "*" }]
PROJ

k apply -k local/
echo "Waiting for Elasticsearch…"; k -n es rollout status statefulset/elasticsearch --timeout=300s

# Secrets the app expects (the hackathon versions come from Elastic Serverless and Dash0).
k -n "team-$TEAM" create secret generic es-credentials \
  --from-literal=url=http://elasticsearch.es:9200 \
  --from-literal=semantic-inference-id="${SEMANTIC_INFERENCE_ID:-.multilingual-e5-small-elasticsearch}" \
  --dry-run=client -o yaml | k apply -f -
k -n "team-$TEAM" create secret generic otlp-backend \
  --from-literal=endpoint=lgtm.observability:4317 --from-literal=token=none --from-literal=insecure=true \
  --dry-run=client -o yaml | k apply -f -
if ! k -n "team-$TEAM" get secret app-credentials >/dev/null 2>&1; then
  k -n "team-$TEAM" create secret generic app-credentials --from-literal=pseudonym-salt="$(openssl rand -hex 16)"
fi

k apply -f argocd/application.yaml
echo "Done. Argo CD syncs deploy/ from GitHub. App: http://127.0.0.1:18080  Grafana: http://127.0.0.1:13300 (on the VM)"
