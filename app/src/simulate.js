// Rehearsal traffic: desks checking people in, booth scanners scanning them, and the
// things that go wrong at real events. Talks to the public API like the real apps do.
//   node src/simulate.js --base http://127.0.0.1:18080 --minutes 10 [--offline radar] [--rate 1]
// --offline <booth>: that booth's scanner loses Wi-Fi from minute 2 to minute 5, queues
// scans on the "device", then flushes them all at once when it reconnects.
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const BASE = opt('base', 'http://127.0.0.1:18080');
const MINUTES = Number(opt('minutes', 10));
const RATE = Number(opt('rate', 1)); // multiplier
const OFFLINE = opt('offline', '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const NOTES = [
  'Runs Argo CD across 40 clusters, wants canary analysis', 'Asked about pricing for 200 engineers',
  'Evaluating OpenTelemetry migration from vendor agents', 'Interested in eBPF security signals',
  'Platform team lead, wants a follow-up demo next week', 'Student, interested in internships',
  'Looking for vector search for their support docs', 'Asked about self-hosting and data residency', '',
];

async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok && r.status !== 404) throw new Error(`${path} ${r.status} ${await r.text()}`);
  return r.json().catch(() => ({}));
}

async function main() {
  const { booths } = await (await fetch(`${BASE}/api/booths`)).json();
  const registry = [];
  for (let n = 10001; n < 10401; n++) registry.push(`B${n}`);
  const checked = [];
  const queues = Object.fromEntries(booths.map((b) => [b.booth_id, []]));
  const start = Date.now();
  const end = start + MINUTES * 60000;
  let i = 0;
  const minute = () => (Date.now() - start) / 60000;
  const offline = (b) => b === OFFLINE && minute() >= 2 && minute() < 5;

  // Heartbeats every 15 s from every scanner that has Wi-Fi.
  const hb = setInterval(() => {
    for (const b of booths) {
      if (offline(b.booth_id)) continue;
      post('/api/scanners/heartbeat', { scanner_id: `scanner-${b.booth_id}`, booth_id: b.booth_id, queue_depth: queues[b.booth_id].length, app_version: 'sim' }).catch(() => {});
    }
  }, 15000);

  while (Date.now() < end) {
    i++;
    // Desks: about one check-in a second at peak.
    if (checked.length < registry.length) {
      const badge = registry[checked.length];
      const r = await post('/api/checkin', { badge_id: badge, desk_id: pick(['desk-1', 'desk-2', 'desk-3']) }).catch(() => null);
      if (r?.ok) checked.push(badge);
    }
    // Booths: scan people who checked in. ~2% are badges that never checked in (shared/forwarded).
    if (checked.length > 5 && Math.random() < 0.8 * RATE) {
      const b = pick(booths).booth_id;
      const neverIn = Math.random() < 0.02 ? `B${20000 + Math.floor(Math.random() * 900)}` : null;
      queues[b].push({ scan_id: `${b}-${Date.now()}-${i}`, badge_id: neverIn || pick(checked), scanned_at: new Date().toISOString(), consent: Math.random() < 0.85, notes: pick(NOTES) });
    }
    // Every ~3 minutes, one badge shows up at two far booths 15 s apart (a shared badge).
    if (i % 180 === 90 && checked.length > 10) {
      const shared = pick(checked);
      const [a, b] = [booths[0].booth_id, booths[booths.length - 1].booth_id];
      const t0 = Date.now();
      queues[a].push({ scan_id: `${a}-${t0}-x`, badge_id: shared, scanned_at: new Date(t0 - 15000).toISOString(), consent: true, notes: '' });
      queues[b].push({ scan_id: `${b}-${t0}-y`, badge_id: shared, scanned_at: new Date(t0).toISOString(), consent: true, notes: '' });
    }
    // Scanners sync every ~5 s when online; the offline one keeps queuing.
    if (i % 5 === 0) {
      for (const b of booths) {
        const q = queues[b.booth_id];
        if (!q.length || offline(b.booth_id)) continue;
        const batch = q.splice(0, q.length);
        const r = await post('/api/scans/batch', { booth_id: b.booth_id, scanner_id: `scanner-${b.booth_id}`, scans: batch }).catch(() => null);
        const stored = new Set(r?.stored || []);
        q.unshift(...batch.filter((s) => !stored.has(s.scan_id))); // keep what didn't make it
      }
    }
    if (i % 30 === 0) console.log(JSON.stringify({ minute: minute().toFixed(1), checked_in: checked.length, queued: Object.fromEntries(Object.entries(queues).filter(([, q]) => q.length).map(([k, q]) => [k, q.length])) }));
    await sleep(1000 / Math.max(0.1, RATE));
  }
  clearInterval(hb);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
