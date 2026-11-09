# Check-in kiosk under eBPF (laptop)

A badge check-in kiosk that checks people in with LeadGuard, watched from the kernel by **OBI** (network flows,
process discovery) and the **OTel eBPF profiler** (CPU profiles per PID). `detect.py` learns what's normal (ports,
peers, hot functions), then flags anything new and follows the PID: port → process → functions. No detection rule
names a port, a binary or a function. Findings go to LeadGuard's organizer view (`POST /api/signals`).

Adapted from **Ekansh Gupta and Shivanshu Raj Shrivastava's** Observability Day rig,
[github.com/eKuG/obs-day-na26](https://github.com/eKuG/obs-day-na26) ("Auto Deriving Threat Signals from OTel CPU
Profiles & OBI Network Flows"). Changes: the "shop" is a LeadGuard check-in kiosk, findings are reported to
LeadGuard, ports moved so it can run next to the demo tunnel.

Why a laptop: eBPF needs privileged containers with host PID, which the Radar team cluster refuses (and should).

```sh
cd kiosk
make up                # kiosk + badge taps + OBI + profiler + Collector + Prometheus + Pyroscope + Grafana
# wait ~3 minutes for flows, process discovery and profiles
make check             # preflight
make learn             # baseline while calm: port 8080, the badge-tap peer, the kiosk's own functions
make incident          # simulated compromise: a listener on :4444 inside the kiosk burning a core in grind_nonce,
                       # and an unknown client polling it (pure Python, no real payload: apps/kiosk/rogue.py)
make report            # NEW PORT + NEW PEER kiosk:4444 <- 172.30.0.66, process 'cache', pid N, ~1 core,
                       # grind_nonce 100%  →  reported to LeadGuard (LEADGUARD_URL, default http://localhost:18080)
make calm              # undo
make down
```

Verified on Docker Desktop (kernel 6.12): detection reported `cache`, 0.88 cores, `grind_nonce` 100% within ~75 s.

| URL | What |
|---|---|
| http://localhost:13301/d/threat-signals/threat-signals?orgId=1&kiosk | Grafana: flows per port, who talks to the kiosk, port → PID, flamegraph |
| http://localhost:19091 | Prometheus (OBI flows) |
| http://localhost:4040 | Pyroscope (profiles per `<exe>:<pid>`) |
| http://localhost:18088/tap | the kiosk (one badge tap) |

The kiosk reaches LeadGuard at `LEADGUARD_URL` (default `http://host.docker.internal:18080`, the SSH tunnel to Civo).
