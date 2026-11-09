// LeadGuard: one image, three roles.
//   ROLE=web        desk, scanner and organizer UI + read APIs. Service app:80 points here.
//   ROLE=ingest     every write that must not be lost: check-ins, scan batches, scanner
//                   heartbeats, ticket-email webhooks. Shipped as an Argo Rollout canary.
//   ROLE=integrity  the detector loop (src/integrity.js); no HTTP besides probes.
// The web role forwards writes to the ingest Service, so one trace covers both.
const path = require('node:path');
const express = require('express');
const { es, INDEX, SEMANTIC, ready } = require('./es');
const m = require('./model');
const t = require('./telemetry');

const ROLE = process.env.ROLE || 'web';
const PORT = Number(process.env.PORT || 8080);
const VERSION = process.env.APP_VERSION || 'dev';
const INGEST_URL = process.env.INGEST_URL || 'http://ingest';
const COLLECTOR_HTTP = process.env.COLLECTOR_HTTP || 'http://otel-collector:4318';
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || '';

const app = express();
app.disable('x-powered-by');

app.get('/healthz', (_req, res) => res.type('text').send('ok\n'));
app.get('/readyz', async (_req, res) => ((await ready()) ? res.type('text').send('ok\n') : res.status(503).send('elasticsearch unreachable\n')));

// Browser RUM → Collector, same origin. Registered before the JSON parser.
if (ROLE === 'web') {
  app.post('/otlp/v1/logs', express.raw({ type: '*/*', limit: '64kb' }), (req, res) => {
    fetch(`${COLLECTOR_HTTP}/v1/logs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: req.body, signal: AbortSignal.timeout(2000) })
      .then((r) => res.status(r.ok ? 204 : 502).end())
      .catch(() => res.status(502).end());
  });
}
app.use(express.json({ limit: '256kb' }));

const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  if (!err.status || err.status >= 500) t.log('error', err.message, { 'http.route': req.route?.path || req.path, 'error.type': err.name || 'Error' });
  res.status(err.status || 500).json({ error: err.status ? err.message : 'internal error' });
});
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const id = (v, name) => { if (!m.isId(v)) throw bad(`invalid ${name}`); return v; };
const now = () => new Date();

// ── ingest role: writes ────────────────────────────────────────────────────
async function checkin(req, res) {
  const badge = id(String(req.body?.badge_id || '').toUpperCase(), 'badge_id');
  const desk = id(req.body?.desk_id || 'desk-1', 'desk_id');
  t.annotate({ 'leadguard.desk.id': desk, 'enduser.pseudo_id': t.pseudonym(badge) });
  const att = await es().get({ index: INDEX.attendees, id: badge }, { ignore: [404] });
  if (!att.found) throw bad('unknown badge', 404);
  const at = now().toISOString();
  await es().index({ index: INDEX.checkins, op_type: 'create', document: { '@timestamp': at, badge_id: badge, desk_id: desk } });
  // First check-in wins; later ones are re-entries.
  // refresh: the integrity sweep must see this check-in before it judges this badge's scans.
  const first = await es().index({ index: INDEX.checkedIn, id: badge, op_type: 'create', refresh: 'wait_for', document: { badge_id: badge, first_checkin_at: at } }, { ignore: [409] });
  const reentry = first.result !== 'created';
  t.checkins.add(1, { 'leadguard.desk.id': desk, 'leadguard.checkin.reentry': reentry });
  res.status(201).json({ ok: true, badge_id: badge, name: att._source.name, reentry });
}

async function scanBatch(req, res) {
  const booth = id(req.body?.booth_id, 'booth_id');
  const scanner = id(req.body?.scanner_id, 'scanner_id');
  const batch = Array.isArray(req.body?.scans) ? req.body.scans.slice(0, 500) : [];
  t.annotate({ 'leadguard.booth.id': booth, 'leadguard.scanner.id': scanner, 'leadguard.batch.size': batch.length });
  const received = now();
  const valid = batch.filter(m.validScan);
  const rejected = batch.length - valid.length;
  const accepted = [], duplicate = [];
  if (valid.length) {
    const ops = [];
    for (const s of valid) {
      const when = m.scanTime(s.scanned_at, received);
      ops.push({ create: { _index: INDEX.scans, _id: s.scan_id } }, {
        '@timestamp': received.toISOString(), scanned_at: when.at, clock: when.clock, skew_ms: when.skew_ms ?? null,
        scan_id: s.scan_id, badge_id: s.badge_id.toUpperCase(), booth_id: booth, scanner_id: scanner, consent: s.consent,
      });
      t.syncLag.record(Math.max(0, (received.getTime() - Date.parse(when.at)) / 1000), { 'leadguard.booth.id': booth });
    }
    const r = await t.inSpan('store scans', { 'leadguard.booth.id': booth, 'leadguard.batch.size': valid.length }, () => es().bulk({ operations: ops }));
    r.items.forEach((it, i) => {
      const s = valid[i];
      if (it.create.status === 201) accepted.push(s);
      else if (it.create.status === 409) duplicate.push(s.scan_id); // retried batch: already stored
      else t.log('error', 'scan not stored', { 'leadguard.booth.id': booth, 'http.response.status_code': it.create.status, 'error.type': it.create.error?.type || 'unknown' });
      // Anything not in `stored` stays on the device and is retried.
    });
    // Duplicates go through too: the merge is idempotent by scan_id, so a batch retried after
    // a failed lead write repairs the lead instead of losing it.
    const forLeads = [...accepted, ...valid.filter((v) => duplicate.includes(v.scan_id))];
    if (forLeads.length) await upsertLeads(booth, forLeads);
  }
  t.scans.add(accepted.length, { 'leadguard.booth.id': booth, outcome: 'accepted' });
  if (duplicate.length) t.scans.add(duplicate.length, { 'leadguard.booth.id': booth, outcome: 'duplicate' });
  if (rejected) t.scans.add(rejected, { 'leadguard.booth.id': booth, outcome: 'rejected' });
  t.log('info', 'scan batch', {
    'leadguard.booth.id': booth, 'leadguard.scanner.id': scanner, 'leadguard.batch.size': batch.length,
    'leadguard.scans.accepted': accepted.length, 'leadguard.scans.duplicate': duplicate.length, 'leadguard.scans.rejected': rejected,
    'leadguard.scans.synced_late': valid.filter((v) => m.scanTime(v.scanned_at, received).clock === 'queued').length,
  });
  // The device deletes everything it sees in `stored`, so a retried batch never double-counts.
  res.json({ stored: [...accepted.map((s) => s.scan_id), ...duplicate], rejected });
}

// One lead per booth+badge. Read, merge (model.mergeLead), write with optimistic concurrency:
// two ingest pods updating the same lead can't overwrite each other; a conflict is retried.
async function upsertLeads(booth, scans, attempt = 1) {
  const groups = new Map();
  for (const s of scans) {
    const badge = s.badge_id.toUpperCase();
    (groups.get(badge) || groups.set(badge, []).get(badge)).push({ scan_id: s.scan_id, at: m.scanTime(s.scanned_at, now()).at, consent: s.consent, notes: s.notes });
  }
  const badges = [...groups.keys()];
  const [people, leads] = await Promise.all([
    es().mget({ index: INDEX.attendees, ids: badges }),
    es().mget({ index: INDEX.leads, ids: badges.map((b) => m.leadId(booth, b)), _source_excludes: ['notes_semantic'] }),
  ]);
  const ops = [];
  badges.forEach((badge, i) => {
    const person = people.docs[i].found ? people.docs[i]._source : null;
    const cur = leads.docs[i];
    const doc = m.mergeLead(cur.found ? cur._source : null, groups.get(badge), person, booth, badge);
    ops.push(cur.found
      ? { index: { _index: INDEX.leads, _id: cur._id, if_seq_no: cur._seq_no, if_primary_term: cur._primary_term } }
      : { create: { _index: INDEX.leads, _id: m.leadId(booth, badge) } }, doc);
  });
  const r = await t.inSpan('upsert leads', { 'leadguard.booth.id': booth, 'leadguard.leads.count': badges.length }, () => es().bulk({ operations: ops }));
  const conflicted = [], failed = [];
  r.items.forEach((it, i) => {
    const res = it.index || it.create;
    if (res.status === 409) conflicted.push(badges[i]);
    else if (res.error) failed.push(`${badges[i]}: ${res.error.type}`);
  });
  if (failed.length) throw new Error(`lead upsert failed for ${failed.length}: ${failed[0]}`);
  if (conflicted.length) {
    if (attempt >= 3) throw new Error(`lead upsert: ${conflicted.length} conflicts after 3 attempts`);
    await upsertLeads(booth, scans.filter((s) => conflicted.includes(s.badge_id.toUpperCase())), attempt + 1);
  }
}

async function heartbeat(req, res) {
  const scanner = id(req.body?.scanner_id, 'scanner_id');
  const booth = id(req.body?.booth_id, 'booth_id');
  const depth = Math.max(0, Number(req.body?.queue_depth) || 0);
  const prev = await es().get({ index: INDEX.scanners, id: scanner }, { ignore: [404] });
  const at = now().toISOString();
  // queue_since: when the queue last went from empty to non-empty.
  const since = depth === 0 ? null : (prev.found && prev._source.queue_depth > 0 && prev._source.queue_since) || at;
  await es().index({ index: INDEX.scanners, id: scanner, document: { scanner_id: scanner, booth_id: booth, last_seen: at, queue_depth: depth, queue_since: since, app_version: String(req.body?.app_version || '').slice(0, 20) } });
  t.queueDepth.record(depth, { 'leadguard.booth.id': booth });
  t.annotate({ 'leadguard.scanner.id': scanner, 'leadguard.scanner.queue_depth': depth });
  res.json({ ok: true });
}

// Email provider webhook: ticket emails sent / delivered / bounced / complained / opened.
async function emailEvents(req, res) {
  if (!WEBHOOK_TOKEN || req.get('x-webhook-token') !== WEBHOOK_TOKEN) throw bad('unauthorized', 401);
  const events = (Array.isArray(req.body) ? req.body : [req.body]).slice(0, 500);
  const ops = [], updates = [];
  for (const e of events) {
    if (!m.isId(String(e?.badge_id || '').toUpperCase()) || !m.EMAIL_STATES.includes(e?.status)) continue;
    const badge = e.badge_id.toUpperCase();
    const at = Number.isNaN(Date.parse(e.at)) ? now().toISOString() : new Date(e.at).toISOString();
    const detail = typeof e.detail === 'string' ? e.detail.slice(0, 200) : null;
    ops.push({ create: { _index: INDEX.emails } }, { '@timestamp': at, badge_id: badge, status: e.status, detail, domain: String(e.domain || '').slice(0, 100).toLowerCase() || null });
    updates.push({ update: { _index: INDEX.attendees, _id: badge } }, { doc: { ticket_email: { status: e.status, at, detail } } });
  }
  if (ops.length) await es().bulk({ operations: [...ops, ...updates] });
  t.annotate({ 'leadguard.email.events': ops.length / 2 });
  res.json({ accepted: ops.length / 2 });
}

if (ROLE === 'ingest') {
  app.post('/api/checkin', wrap(checkin));
  app.post('/api/scans/batch', wrap(scanBatch));
  app.post('/api/scanners/heartbeat', wrap(heartbeat));
  app.post('/api/email/events', wrap(emailEvents));
}

// ── web role: reads + forwarding ───────────────────────────────────────────
if (ROLE === 'web') {
  const forward = (p) => wrap(async (req, res) => {
    const r = await fetch(`${INGEST_URL}${p}`, {
      method: 'POST', body: JSON.stringify(req.body ?? {}), signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/json', ...(req.get('x-webhook-token') ? { 'x-webhook-token': req.get('x-webhook-token') } : {}) },
    });
    res.status(r.status).type('json').send(await r.text());
  });
  for (const p of ['/api/checkin', '/api/scans/batch', '/api/scanners/heartbeat', '/api/email/events']) app.post(p, forward(p));

  app.get('/api/config', (_req, res) => res.json({ version: VERSION, venue_tz: m.VENUE_TZ, expo_hours: process.env.EXPO_HOURS || null, semantic: Boolean(SEMANTIC) }));

  app.get('/api/attendees/search', wrap(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2) throw bad('q needs at least 2 characters');
    const r = await t.inSpan('search attendees', {}, (span) => es().search({ index: INDEX.attendees, ...m.attendeeSearch(q) }).then((x) => {
      span.setAttribute('leadguard.search.results', x.hits.hits.length); return x;
    }));
    const badges = r.hits.hits.map((h) => h._id);
    const seen = badges.length ? await es().mget({ index: INDEX.checkedIn, ids: badges }) : { docs: [] };
    const checked = Object.fromEntries(seen.docs.filter((d) => d.found).map((d) => [d._id, d._source.first_checkin_at]));
    t.annotate({ 'leadguard.search.results': badges.length, 'leadguard.search.zero_results': badges.length === 0 });
    res.json({ results: r.hits.hits.map((h) => ({ ...h._source, score: h._score, checked_in_at: checked[h._id] || null, email_risk: m.ticketEmailRisk(h._source.ticket_email, now()) })) });
  }));

  // At the desk: attach the email the person has today (job change), so next time it just works.
  app.post('/api/attendees/:badge/emails', wrap(async (req, res) => {
    const badge = id(String(req.params.badge).toUpperCase(), 'badge');
    const email = m.normEmail(req.body?.email);
    if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email)) throw bad('invalid email');
    await es().update({ index: INDEX.attendees, id: badge, script: { source: 'if (!ctx._source.emails.contains(params.e)) { ctx._source.emails.add(params.e) }', params: { e: email } } });
    res.json({ ok: true });
  }));

  app.get('/api/attendees/at-risk', wrap(async (_req, res) => {
    const r = await es().search({
      index: INDEX.attendees, size: 200,
      // Walk-ups got their badge at the desk, so a missing ticket email isn't a risk for them.
      query: { bool: { should: [{ terms: { 'ticket_email.status': ['bounced', 'complained', 'sent'] } }, { bool: { must_not: { exists: { field: 'ticket_email.status' } } } }], minimum_should_match: 1, must_not: [{ term: { ticket_type: 'walk-up' } }] } },
    });
    const ids = r.hits.hits.map((h) => h._id);
    const seen = ids.length ? await es().mget({ index: INDEX.checkedIn, ids }) : { docs: [] };
    const checked = new Set(seen.docs.filter((d) => d.found).map((d) => d._id));
    const out = r.hits.hits.map((h) => ({ badge_id: h._id, name: h._source.name, company: h._source.company, risk: m.ticketEmailRisk(h._source.ticket_email, now()) }))
      .filter((a) => a.risk.at_risk && !checked.has(a.badge_id));
    res.json({ attendees: out });
  }));

  // Walk-up registration at the desk (and how we register judges for the live demo).
  app.post('/api/attendees', wrap(async (req, res) => {
    const name = String(req.body?.name ?? '').trim().slice(0, 100);
    const email = m.normEmail(req.body?.email);
    const company = String(req.body?.company ?? '').trim().slice(0, 100);
    if (name.length < 2) throw bad('name is required');
    if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email)) throw bad('invalid email');
    const dupe = await es().search({ index: INDEX.attendees, size: 1, query: { term: { emails: email } } });
    if (dupe.hits.hits.length) return res.status(409).json({ error: 'already registered', badge_id: dupe.hits.hits[0]._id });
    const badge = `W${Date.now().toString(36).toUpperCase().slice(-5)}${Math.floor(Math.random() * 36).toString(36).toUpperCase()}`;
    await es().index({ index: INDEX.attendees, id: badge, op_type: 'create', refresh: 'wait_for', document: { badge_id: badge, order_id: `WALKUP-${badge}`, name, emails: [email], company, ticket_type: 'walk-up', registered_at: new Date().toISOString(), synthetic: false } });
    t.annotate({ 'leadguard.attendee.ticket_type': 'walk-up' });
    res.status(201).json({ badge_id: badge, name, company });
  }));

  // Badges to print: walk-ups (newest first), or explicit ids. Name, company and badge id only.
  app.get('/api/badges', wrap(async (req, res) => {
    const ids = String(req.query.ids ?? '').split(',').map((x) => x.trim().toUpperCase()).filter(m.isId).slice(0, 60);
    const r = ids.length
      ? await es().mget({ index: INDEX.attendees, ids })
      : await es().search({ index: INDEX.attendees, size: 60, query: { term: { ticket_type: 'walk-up' } }, sort: [{ registered_at: { order: 'desc', unmapped_type: 'date' } }] });
    const docs = ids.length ? r.docs.filter((d) => d.found) : r.hits.hits;
    res.json({ badges: docs.map((d) => ({ badge_id: d._id, name: d._source.name, company: d._source.company, ticket_type: d._source.ticket_type })) });
  }));

  // Browser libraries for badges (QR generation) and scanning on phones without BarcodeDetector.
  const vendor = { 'qrcode.js': require.resolve('qrcode-generator'), 'jsQR.js': require.resolve('jsqr') };
  app.get('/vendor/:file', (req, res) => (vendor[req.params.file] ? res.type('js').sendFile(vendor[req.params.file]) : res.status(404).end()));

  app.get('/api/booths', wrap(async (_req, res) => {
    const r = await es().search({ index: INDEX.booths, size: 100, sort: [{ booth_id: 'asc' }] });
    res.json({ booths: r.hits.hits.map((h) => h._source) });
  }));

  app.get('/api/booths/health', wrap(async (_req, res) => {
    const [booths, stats, scanners, open] = await Promise.all([
      es().search({ index: INDEX.booths, size: 100 }),
      es().search({ index: INDEX.leads, size: 0, ignore_unavailable: true, aggs: { b: { terms: { field: 'booth_id', size: 100 }, aggs: { consented: { filter: { term: { consent: true } } }, last: { max: { field: 'last_seen' } } } } } }),
      es().search({ index: INDEX.scanners, size: 200, ignore_unavailable: true }),
      es().search({ index: INDEX.anomalies, size: 0, ignore_unavailable: true, query: { term: { status: 'open' } }, aggs: { b: { terms: { field: 'booth_id', size: 100 } } } }),
    ]);
    const by = (r) => Object.fromEntries((r.aggregations?.b?.buckets ?? []).map((b) => [b.key, b]));
    const st = by(stats), an = by(open);
    const sc = scanners.hits.hits.map((h) => h._source);
    res.json({
      booths: booths.hits.hits.map((h) => {
        const b = h._source;
        const mine = sc.filter((s) => s.booth_id === b.booth_id);
        return { ...b, leads: st[b.booth_id]?.doc_count ?? 0, consented: st[b.booth_id]?.consented.doc_count ?? 0, last_lead: st[b.booth_id]?.last.value_as_string ?? null, open_anomalies: an[b.booth_id]?.doc_count ?? 0, scanners: mine };
      }),
    });
  }));

  app.get('/api/anomalies', wrap(async (req, res) => {
    const status = req.query.status === 'resolved' ? 'resolved' : 'open';
    const r = await es().search({ index: INDEX.anomalies, size: 200, ignore_unavailable: true, query: { term: { status } }, sort: [{ last_seen: 'desc' }] });
    res.json({ anomalies: r.hits.hits.map((h) => ({ id: h._id, ...h._source, explain: m.EXPLAIN[h._source.kind] })) });
  }));

  app.get('/api/leads', wrap(async (req, res) => {
    const booth = id(req.query.booth, 'booth');
    const q = String(req.query.q ?? '').trim().slice(0, 200);
    const filter = [{ term: { booth_id: booth } }, { term: { consent: true } }];
    const mode = q ? (SEMANTIC ? 'hybrid' : 'keyword') : 'list';
    t.annotate({ 'leadguard.booth.id': booth, 'leadguard.search.mode': mode });
    const keyword = { bool: { filter, must: { match: { notes: { query: q, fuzziness: 'AUTO' } } } } };
    const semantic = { bool: { filter, must: { semantic: { field: 'notes_semantic', query: q } } } };
    const search = mode === 'hybrid'
      ? { retriever: { rrf: { retrievers: [{ standard: { query: keyword } }, { standard: { query: semantic } }], rank_window_size: 50 } } }
      : mode === 'keyword' ? { query: keyword } : { query: { bool: { filter } }, sort: [{ last_seen: 'desc' }] };
    const r = await es().search({ index: INDEX.leads, size: 50, ...search, _source: { excludes: ['notes_semantic', 'scan_ids'] } });
    res.json({ mode, leads: r.hits.hits.map((h) => h._source) });
  }));

  // Consented leads only, as CSV for the sponsor.
  app.get('/api/leads/export.csv', wrap(async (req, res) => {
    const booth = id(req.query.booth, 'booth');
    const r = await es().search({ index: INDEX.leads, size: 5000, query: { bool: { filter: [{ term: { booth_id: booth } }, { term: { consent: true } }] } }, sort: [{ first_seen: 'asc' }] });
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = r.hits.hits.map((h) => [h._source.name, h._source.email, h._source.company, h._source.first_seen, h._source.scan_count, h._source.notes].map(cell).join(','));
    t.annotate({ 'leadguard.booth.id': booth, 'leadguard.leads.count': rows.length });
    res.type('text/csv').attachment(`leads-${booth}.csv`).send(['name,email,company,first_seen,scans,notes', ...rows].join('\n'));
  }));

  app.get('/api/stats', wrap(async (_req, res) => {
    const [ci, sc, att] = await Promise.all([
      es().search({ index: INDEX.checkins, size: 0, ignore_unavailable: true, query: { range: { '@timestamp': { gte: 'now-30m' } } }, aggs: { per_min: { date_histogram: { field: '@timestamp', fixed_interval: '1m' } }, desks: { terms: { field: 'desk_id' } } } }),
      es().count({ index: INDEX.scans, ignore_unavailable: true }),
      es().count({ index: INDEX.checkedIn, ignore_unavailable: true }),
    ]);
    res.json({
      checked_in: att.count, scans: sc.count,
      checkins_per_min: (ci.aggregations?.per_min?.buckets ?? []).map((b) => ({ at: b.key_as_string, n: b.doc_count })),
      desks: (ci.aggregations?.desks?.buckets ?? []).map((b) => ({ desk_id: b.key, n: b.doc_count })),
    });
  }));

  app.get('/api/signals', wrap(async (_req, res) => {
    const r = await es().search({ index: INDEX.signals, size: 20, ignore_unavailable: true, sort: [{ '@timestamp': 'desc' }] });
    res.json({ signals: r.hits.hits.map((h) => h._source) });
  }));

  // Threat signals from the check-in kiosks (kiosk/detect.py).
  app.post('/api/signals', wrap(async (req, res) => {
    const b = req.body ?? {};
    const doc = {
      '@timestamp': now().toISOString(), kiosk_id: id(b.kiosk_id, 'kiosk_id'),
      kind: ['new_port', 'new_peer', 'new_hot_function'].includes(b.kind) ? b.kind : 'unknown',
      port: Number(b.port) || null, peer: typeof b.peer === 'string' ? b.peer.slice(0, 64) : null,
      process: typeof b.process === 'string' ? b.process.slice(0, 64) : null, cpu_cores: Number(b.cpu_cores) || null,
      top_function: typeof b.top_function === 'string' ? b.top_function.slice(0, 128) : null,
    };
    t.annotate({ 'leadguard.signal.kind': doc.kind });
    await es().index({ index: INDEX.signals, document: doc });
    res.status(201).json({ ok: true });
  }));

  require('./ops').mount(app, wrap); // MCP for AURA + "Ask ops"

  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '5m' }));
}

if (ROLE === 'integrity') require('./integrity').start();
if (ROLE === 'web' && process.env.SEED_ON_START !== 'false') require('./seed').ensure();

const server = app.listen(PORT, () => t.log('info', `leadguard ${ROLE} listening`, { 'leadguard.role': ROLE, 'service.version': VERSION }));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
