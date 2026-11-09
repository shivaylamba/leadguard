# A badge check-in kiosk: tap a badge, the kiosk checks it in with LeadGuard.
# Nothing here knows about eBPF: OBI and the profiler watch it from the kernel.
import json, os, random, time, urllib.request
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

LEADGUARD = os.environ.get("LEADGUARD_URL", "http://host.docker.internal:18080")
KIOSK_ID = os.environ.get("KIOSK_ID", "kiosk-1")


def render_badge(badge):
    # Some real CPU work (laying out the printed badge), so the profiler has Python frames to show.
    def fib(n):
        return n if n < 2 else fib(n - 1) + fib(n - 2)
    return fib(18 + len(badge) % 3)


def check_in(badge):
    body = json.dumps({"badge_id": badge, "desk_id": KIOSK_ID}).encode()
    req = urllib.request.Request(f"{LEADGUARD}/api/checkin", data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=3) as r:
            return r.status, json.load(r)
    except Exception as e:  # noqa: BLE001 - the kiosk keeps working if LeadGuard is unreachable
        return 503, {"error": str(e)[:120]}


class Kiosk(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/tap"):
            badge = f"B{random.randint(10001, 10400)}"
            render_badge(badge)
            status, out = check_in(badge)
            body = json.dumps({"badge": badge, "leadguard": status, **({"name": out.get("name")} if status == 201 else {})}).encode()
        else:
            body = json.dumps({"kiosk": KIOSK_ID, "ok": True}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8080"))), Kiosk).serve_forever()
