// The integrity loop (ROLE=integrity): every INTEGRITY_INTERVAL_S seconds, run the detectors
// and upsert anomalies. One replica is enough; ids are deterministic, so a second
// replica or a restart re-detects the same anomalies instead of duplicating them.
const { es, INDEX } = require('./es');
const m = require('./model');
const t = require('./telemetry');

const INTERVAL_S = Number(process.env.INTEGRITY_INTERVAL_S || 30);
const WINDOW_MIN = Number(process.env.INTEGRITY_WINDOW_MIN || 240);
// Re-evaluated every sweep: they clear when the condition does (the badge checks in late,
// the booth scans again, the scanner syncs). impossible_travel is historical and stays open.
const SELF_CLEARING = ['never_checked_in', 'scanned_before_checkin', 'silent_booth', 'scanner_offline', 'scans_not_syncing', 'scan_rate_anomaly'];

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

// Elastic ML records for the per-booth scan-rate job (src/seed.js). Absent job = no ML anomalies.
async function mlAnomalies() {
  try {
    const r = await es().ml.getRecords({ job_id: 'leadguard-booth-scan-rate', start: 'now-30m', record_score: 75, sort: 'record_score', desc: true }, { ignore: [404] });
    return (r.records ?? []).map((x) => ({ kind: 'scan_rate_anomaly', booth_id: x.partition_field_value, detail: { score: Math.round(x.record_score), actual: x.actual?.[0], typical: Math.round((x.typical?.[0] ?? 0) * 10) / 10, bucket: new Date(x.timestamp).toISOString() } }));
  } catch {
    return [];
  }
}

async function tick() {
  return t.inSpan('integrity sweep', {}, async (span) => {
    const boothsResp = await es().search({ index: INDEX.booths, size: 200 });
    const booths = Object.fromEntries(boothsResp.hits.hits.map((h) => [h._source.booth_id, h._source]));
    const found = [...(await leadAnomalies()), ...(await travelAnomalies(booths)), ...(await boothAnomalies()), ...(await mlAnomalies())];
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
      if (r.errors) throw new Error(`anomaly upsert: ${JSON.stringify(r.items.find((x) => x.update?.error).update.error).slice(0, 200)}`);
      r.items.forEach((it, i) => {
        if (it.update.result !== 'created') return;
        created++;
        t.anomalies.add(1, { 'leadguard.anomaly.kind': found[i].kind });
        t.log('warn', `anomaly: ${found[i].kind}`, { 'leadguard.anomaly.kind': found[i].kind, 'leadguard.booth.id': found[i].booth_id || '', 'leadguard.anomaly.explain': m.EXPLAIN[found[i].kind] || '' });
      });
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
    try { await tick(); } catch (err) { t.log('error', `integrity sweep failed: ${err.message}`, { 'error.type': err.name || 'Error' }); } finally { running = false; }
  };
  setTimeout(loop, 5000);
  setInterval(loop, INTERVAL_S * 1000);
  t.log('info', 'integrity loop started', { 'leadguard.integrity.interval_s': INTERVAL_S, 'leadguard.integrity.window_min': WINDOW_MIN });
}

module.exports = { start, tick };
