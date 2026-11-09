"""Run every Dash0 query (dashboard panels and check rules) against the local Prometheus before
it goes to Dash0. Dash0 names OTel metrics Prometheus-style with unit suffixes and service_name;
the in-cluster Prometheus scrapes the SDK exporter (no unit suffix, pod instead of service).
Usage: python3 observability/check.py http://<prometheus>   (or via kubectl port-forward)"""
import json
import os
import re
import sys
import urllib.parse
import urllib.request

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
PROM = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:9090"
POD = {"leadguard-ingest": "ingest-.*", "leadguard-web": "app-.*", "leadguard-integrity": "integrity-.*"}
# From the Collector's count connector: these go to the OTLP backend (Dash0), not the in-cluster Prometheus.
BACKEND_ONLY = ["leadguard_desk_not_found_total"]


def to_local(q):
    q = q.replace("$__threshold", "-1")
    q = re.sub(r"_seconds_(bucket|count|sum)", r"_\1", q)
    q = re.sub(r'service_name="([^"]+)"', lambda m: f'pod=~"{POD[m.group(1)]}"', q)
    q = q.replace('service_name=~"leadguard-.*"', 'namespace=~"team-.*"')
    return q


def run(q):
    url = f"{PROM}/api/v1/query?" + urllib.parse.urlencode({"query": q})
    with urllib.request.urlopen(url, timeout=10) as r:
        d = json.load(r)
    return d["status"], len(d["data"]["result"])


def queries():
    for doc in yaml.safe_load_all(open(os.path.join(HERE, "dash0", "check-rules.yaml"))):
        for g in doc["spec"]["groups"]:
            for rule in g["rules"]:
                yield f"rule {rule['alert']}", rule["expr"]
    dash = yaml.safe_load(open(os.path.join(HERE, "dash0", "dashboard.yaml")))
    for pid, p in dash["spec"]["panels"].items():
        yield f"panel {pid}", p["spec"]["queries"][0]["spec"]["plugin"]["spec"]["query"]


bad = 0
for name, q in queries():
    if any(m in q for m in BACKEND_ONLY):
        print(f"SKIP   {name}: Collector-derived metric, only in the OTLP backend")
        continue
    try:
        status, n = run(to_local(q))
        mark = "OK   " if n else "EMPTY"
        print(f"{mark}  {name}: {n} series")
    except Exception as e:  # noqa: BLE001
        bad += 1
        print(f"ERROR  {name}: {e}")
sys.exit(1 if bad else 0)
