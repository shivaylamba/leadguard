// The integrity loop (ROLE=integrity): every INTEGRITY_INTERVAL_S seconds, run the detectors
// and upsert anomalies. One replica is enough; ids are deterministic, so a second
// replica or a restart re-detects the same anomalies instead of duplicating them.
const { es, INDEX } = require('./es');
const m = require('./model');
const t = require('./telemetry');

const INTERVAL_S = Number(process.env.INTEGRITY_INTERVAL_S || 30);
const WINDOW_MIN = Number(process.env.INTEGRITY_WINDOW_MIN || 240);
// Booth and scanner problems clear themselves when fixed; lead problems wait for an organizer.
const SELF_CLEARING = ['silent_booth', 'scanner_offline', 'scans_not_syncing'];

async function leadAnomalies() {
  const r = await es().esql.query({ query: m.integrityEsql(WINDOW_MIN) });
  const idx = Object.fromEntries(r.columns.map((c, i) => [c.name, i]));
  return r.values.map((v) => ({
    kind: v[idx.kind], badge_id: v[idx.badge_id], booth_id: v[idx.booth_id],
    detail: { scans: v[idx.scans], first_scan: v[idx.first_scan], last_scan: v[idx.last_scan] },
  }));
}

async function travelAnomalies(booths) {
  const r = await es().search({
    index: INDEX.scans, size: 5000, ignore_unavailable: true,
    query: { range: { scanned_at: { gte: 'now-15m' } } },
    _source: ['badge_id', 'booth_id', 'scanned_at'],
  });
  return m.impossibleTravel(r.hits.hits.map((h) => h._source), booths).map((a) => ({ ...a, detail: { from_booth: a.from_booth, metres: a.metres, seconds: a.seconds } }));
}

async function boothAnomalies() {
  const [stats, scanners] = await Promise.all([
    es().search({
      index: INDEX.scans, size: 0, ignore_unavailable: true, query: { range: { '@timestamp': { gte: 'now-60m' } } },
      aggs: { b: { terms: { field: 'booth_id', size: 200 }, aggs: { last: { max: { field: 'scanned_at' } } } } },
    }),
    es().search({ index: INDEX.scanners, size: 500, ignore_unavailable: true }),
  ]);
  const st = (stats.aggregations?.b?.buckets ?? []).map((b) => ({ booth_id: b.key, scans_last_hour: b.doc_count, last_scan: b.last.value_as_string }));
  return m.boothHealth(st, scanners.hits.hits.map((h) => h._source), new Date(), { expoOpen: m.isExpoOpen(new Date()) })
    .map((a) => ({ ...a, detail: { minutes_silent: a.minutes_silent, minutes_offline: a.minutes_offline, queue_depth: a.queue_depth } }));
}

async function tick() {
  return t.inSpan('integrity sweep', {}, async (span) => {
    const boothsResp = await es().search({ index: INDEX.booths, size: 200 });
    const booths = Object.fromEntries(boothsResp.hits.hits.map((h) => [h._source.booth_id, h._source]));
    const found = [...(await leadAnomalies()), ...(await travelAnomalies(booths)), ...(await boothAnomalies())];
    const at = new Date().toISOString();
    const ops = [];
    for (const a of found) {
      ops.push({ update: { _index: INDEX.anomalies, _id: m.anomalyId(a), retry_on_conflict: 3 } }, {
        script: { source: "ctx._source.last_seen = params.at; ctx._source.detail = params.detail; if (ctx._source.status == 'resolved' && params.reopen) { ctx._source.status = 'open'; }", params: { at, detail: a.detail, reopen: SELF_CLEARING.includes(a.kind) } },
        upsert: { kind: a.kind, booth_id: a.booth_id ?? null, badge_id: a.badge_id ?? null, scanner_id: a.scanner_id ?? null, detail: a.detail, status: 'open', first_detected: at, last_seen: at },
      });
    }
    let created = 0;
    if (ops.length) {
      const r = await es().bulk({ operations: ops, refresh: 'wait_for' });
      r.items.forEach((it, i) => { if (it.update.result === 'created') { created++; t.anomalies.add(1, { 'leadguard.anomaly.kind': found[i].kind }); } });
    }
    // Clear booth/scanner anomalies that are no longer detected.
    const live = new Set(found.filter((a) => SELF_CLEARING.includes(a.kind)).map(m.anomalyId));
    const openSelf = await es().search({ index: INDEX.anomalies, size: 500, query: { bool: { filter: [{ term: { status: 'open' } }, { terms: { kind: SELF_CLEARING } }] } }, _source: false });
    const clear = openSelf.hits.hits.filter((h) => !live.has(h._id));
    if (clear.length) await es().bulk({ operations: clear.flatMap((h) => [{ update: { _index: INDEX.anomalies, _id: h._id } }, { doc: { status: 'resolved', resolved_at: at } }]) });
    span.setAttributes({ 'leadguard.anomalies.found': found.length, 'leadguard.anomalies.created': created, 'leadguard.anomalies.cleared': clear.length });
  });
}

function start() {
  let running = false;
  const loop = async () => {
    if (running) return; // a slow sweep never overlaps the next one
    running = true;
    try { await tick(); } catch (err) { console.error(JSON.stringify({ level: 'error', msg: `integrity sweep: ${err.message}` })); } finally { running = false; }
  };
  setTimeout(loop, 5000);
  setInterval(loop, INTERVAL_S * 1000);
  console.log(JSON.stringify({ level: 'info', msg: 'integrity loop started', interval_s: INTERVAL_S, window_min: WINDOW_MIN }));
}

module.exports = { start, tick };
