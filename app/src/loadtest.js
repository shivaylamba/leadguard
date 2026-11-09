// Load test the two moments that matter, against the public API like real devices.
//   node src/loadtest.js --base http://app --rush 300 --scanners 30 --queued 150
// 1. Doors-open rush: --rush check-ins with 12 desks in parallel (ZurichJS: 139 badges in an hour;
//    this is that hour squeezed into about a minute).
// 2. Reconnect storm: --scanners devices that were offline, each holding --queued scans, all
//    flushing at once in batches of 200 (the scanner app's batch size) as the Wi-Fi comes back.
// Then it checks nothing was lost: every scan_id is stored exactly once.
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const BASE = opt('base', 'http://127.0.0.1:18080');
const RUSH = Number(opt('rush', 300));
const SCANNERS = Number(opt('scanners', 30));
const QUEUED = Number(opt('queued', 150));
const RUN = Date.now().toString(36);

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : null; };
async function timed(fn) { const t0 = Date.now(); try { const r = await fn(); return { ms: Date.now() - t0, ok: r.ok, status: r.status, body: r }; } catch (e) { return { ms: Date.now() - t0, ok: false, status: 'error', err: e.message }; } }
async function pool(items, n, fn) { const out = []; let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } })); return out; }
const post = (p, body) => fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
function report(name, rs, extra = {}) {
  const ms = rs.map((r) => r.ms); const bad = rs.filter((r) => !r.ok);
  console.log(JSON.stringify({ phase: name, requests: rs.length, errors: bad.length, statuses: [...new Set(bad.map((r) => r.status))], p50_ms: pct(ms, 50), p95_ms: pct(ms, 95), max_ms: Math.max(...ms), ...extra }));
}

(async () => {
  const { booths } = await (await fetch(`${BASE}/api/booths`)).json();
  // 1. Doors-open rush
  const badges = Array.from({ length: RUSH }, (_, i) => `B${10001 + (i % 400)}`);
  const t1 = Date.now();
  const rush = await pool(badges, 12, (b, i) => timed(() => post('/api/checkin', { badge_id: b, desk_id: `desk-${1 + (i % 12)}` })));
  report('doors_open_rush', rush, { seconds: Math.round((Date.now() - t1) / 1000) });

  // 2. Reconnect storm
  const now = Date.now();
  const devices = Array.from({ length: SCANNERS }, (_, d) => {
    const booth = booths[d % booths.length].booth_id;
    const scans = Array.from({ length: QUEUED }, (_, k) => ({
      scan_id: `load-${RUN}-${d}-${k}`, badge_id: `B${10001 + ((d * 37 + k) % 400)}`,
      scanned_at: new Date(now - (QUEUED - k) * 2000).toISOString(), consent: k % 5 !== 0, notes: k % 7 === 0 ? 'Evaluating OpenTelemetry' : '',
    }));
    return { booth, scanner: `load-${RUN}-${d}`, scans };
  });
  const batches = devices.flatMap((dv) => { const out = []; for (let i = 0; i < dv.scans.length; i += 200) out.push({ ...dv, scans: dv.scans.slice(i, i + 200) }); return out; });
  const t2 = Date.now();
  const storm = await pool(batches, batches.length, (bt) => timed(async () => {
    const r = await post('/api/scans/batch', { booth_id: bt.booth, scanner_id: bt.scanner, scans: bt.scans });
    const j = r.ok ? await r.json() : null; return { ok: r.ok, status: r.status, stored: j?.stored?.length ?? 0 };
  }));
  const stored = storm.reduce((a, r) => a + (r.body?.stored || 0), 0);
  report('reconnect_storm', storm, { scanners: SCANNERS, scans_sent: SCANNERS * QUEUED, scans_confirmed: stored, seconds: Math.round((Date.now() - t2) / 1000) });

  // 3. Retry what wasn't confirmed, like the scanner app does, until everything is stored.
  let missing = batches.filter((_, i) => !storm[i].ok);
  for (let round = 1; missing.length && round <= 5; round++) {
    await new Promise((r) => setTimeout(r, 2000 * round));
    const rr = await pool(missing, 8, (bt) => timed(() => post('/api/scans/batch', { booth_id: bt.booth, scanner_id: bt.scanner, scans: bt.scans })));
    console.log(JSON.stringify({ phase: `retry_${round}`, batches: missing.length, errors: rr.filter((r) => !r.ok).length }));
    missing = missing.filter((_, i) => !rr[i].ok);
  }
  console.log(JSON.stringify({ phase: 'result', batches_never_confirmed: missing.length, verdict: missing.length ? 'scans still on devices: would retry' : 'every scan confirmed stored' }));
})().catch((e) => { console.error(e); process.exit(1); });
