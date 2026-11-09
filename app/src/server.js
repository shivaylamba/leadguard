// Overflow: one image, two roles.
//   ROLE=web      the attendee/organizer UI + read APIs (Service app:80 points here)
//   ROLE=checkin  POST /api/checkin only; shipped as an Argo Rollout canary
// The web role proxies /api/checkin to the checkin Service, so one trace spans both.
const path = require('node:path');
const express = require('express');
const { es, INDEX, SEMANTIC, ready } = require('./es');
const q = require('./queries');
const t = require('./telemetry');

const ROLE = process.env.ROLE || 'web';
const PORT = Number(process.env.PORT || 8080);
const VERSION = process.env.APP_VERSION || 'dev';
const CHECKIN_URL = process.env.CHECKIN_URL || 'http://checkin';
const WINDOW_MIN = Number(process.env.OCCUPANCY_WINDOW_MIN || 90);

const app = express();
app.disable('x-powered-by');

// Browser RUM: forward OTLP/JSON log batches to the in-cluster Collector, same origin, no CORS.
const COLLECTOR_HTTP = process.env.COLLECTOR_HTTP || 'http://otel-collector:4318';
if (ROLE === 'web') {
  app.post('/otlp/v1/logs', express.raw({ type: '*/*', limit: '64kb' }), (req, res) => {
    fetch(`${COLLECTOR_HTTP}/v1/logs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: req.body, signal: AbortSignal.timeout(2000) })
      .then((r) => res.status(r.ok ? 204 : 502).end())
      .catch(() => res.status(502).end());
  });
}
app.use(express.json({ limit: '16kb' }));

app.get('/healthz', (_req, res) => res.type('text').send('ok\n'));
app.get('/readyz', async (_req, res) => ((await ready()) ? res.type('text').send('ok\n') : res.status(503).send('elasticsearch unreachable\n')));

const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(JSON.stringify({ level: 'error', msg: err.message, route: req.path }));
  res.status(err.status || 500).json({ error: err.status ? err.message : 'internal error' });
});
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const id = (v, name) => {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v)) throw bad(`invalid ${name}`);
  return v;
};

async function roomsById() {
  const r = await es().search({ index: INDEX.rooms, size: 200, query: { match_all: {} } });
  return Object.fromEntries(r.hits.hits.map((h) => [h._source.room_id, h._source]));
}

async function occupancy() {
  const since = new Date(Date.now() - WINDOW_MIN * 60000).toISOString();
  // ignore_unavailable: before the first check-in there's nothing to count, which is zero, not an error.
  return t.inSpan('occupancy lookup', {}, async () =>
    q.occupancyFromAgg(await es().search({ index: INDEX.checkins, ignore_unavailable: true, ...q.occupancyAgg(since) })));
}

// ── check-in (ROLE=checkin serves it; web proxies) ─────────────────────────
async function doCheckin(req, res) {
  const room = id(req.body?.room_id, 'room_id');
  const direction = req.body?.direction === 'out' ? 'out' : 'in';
  const device = t.pseudonym(req.body?.device_id);
  t.annotate({ 'conference.room.id': room, 'enduser.pseudo_id': device });
  await es().index({
    index: INDEX.checkins,
    document: { '@timestamp': new Date().toISOString(), room_id: room, direction, device_hash: device, source: req.body?.source === 'kiosk' ? 'kiosk' : 'phone' },
  });
  t.checkins.add(1, { 'conference.room.id': room, direction });
  res.status(201).json({ ok: true, room_id: room, direction });
}

if (ROLE === 'checkin') {
  app.post('/api/checkin', wrap(doCheckin));
} else {
  app.post('/api/checkin', wrap(async (req, res) => {
    const r = await fetch(`${CHECKIN_URL}/api/checkin`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req.body ?? {}),
      signal: AbortSignal.timeout(3000),
    });
    res.status(r.status).type('json').send(await r.text());
  }));

  app.get('/api/config', (_req, res) => res.json({ version: VERSION, semantic: Boolean(SEMANTIC), occupancy_window_min: WINDOW_MIN }));

  app.get('/api/search', wrap(async (req, res) => {
    const text = String(req.query.q ?? '').trim().slice(0, 200);
    if (!text) throw bad('q is required');
    const mode = ['keyword', 'semantic', 'hybrid'].includes(req.query.mode) ? req.query.mode : 'hybrid';
    const built = q.searchBody(text, mode, { captions: req.query.captions === 'true' }, Boolean(SEMANTIC));
    const r = await t.inSpan('search sessions', { 'search.mode': built.mode }, async (span) => {
      const out = await es().search({ index: INDEX.sessions, ...built.body });
      span.setAttribute('search.results.count', out.hits.hits.length);
      return out;
    });
    const results = r.hits.hits.map((h) => ({ ...h._source, score: h._score }));
    const zero = results.length === 0;
    t.annotate({ 'search.mode': built.mode, 'search.results.count': results.length, 'search.zero_results': zero });
    t.searches.add(1, { 'search.mode': built.mode, 'search.zero_results': zero });
    es().index({ index: INDEX.queries, document: { '@timestamp': new Date().toISOString(), q: text, mode: built.mode, results: results.length, zero_results: zero } })
      .catch(() => {}); // analytics must never fail a search
    res.json({ mode: built.mode, results });
  }));

  app.get('/api/sessions/:id', wrap(async (req, res) => {
    const sid = id(req.params.id, 'session id');
    t.annotate({ 'conference.session.id': sid });
    const r = await es().search({ index: INDEX.sessions, size: 1, query: { term: { session_id: sid } }, _source: { excludes: ['abstract_semantic'] } });
    if (!r.hits.hits.length) return res.status(404).json({ error: 'not found' });
    res.json(r.hits.hits[0]._source);
  }));

  app.get('/api/rooms/occupancy', wrap(async (_req, res) => {
    const [rooms, occ] = await Promise.all([roomsById(), occupancy()]);
    const out = Object.values(rooms).map((r) => ({ ...r, inside: occ[r.room_id] ?? 0, load: (occ[r.room_id] ?? 0) / r.capacity }));
    t.annotate({ 'conference.rooms.count': out.length });
    res.json({ window_min: WINDOW_MIN, rooms: out.sort((a, b) => b.load - a.load) });
  }));

  app.put('/api/prefs', wrap(async (req, res) => {
    const device = t.pseudonym(req.body?.device_id);
    const prefs = {
      device_hash: device,
      step_free: Boolean(req.body?.step_free),
      captions: Boolean(req.body?.captions),
      sensory_friendly: Boolean(req.body?.sensory_friendly),
      language: typeof req.body?.language === 'string' ? req.body.language.slice(0, 8) : 'en',
      updated_at: new Date().toISOString(),
    };
    await es().index({ index: INDEX.prefs, id: device, document: prefs });
    res.json(prefs);
  }));

  // Room full? The most similar talk starting around now, in a room with seats.
  app.get('/api/overflow', wrap(async (req, res) => {
    const sid = id(req.query.session, 'session');
    t.annotate({ 'conference.session.id': sid });
    await t.inSpan('recommend overflow', { 'conference.session.id': sid }, async (span) => {
      const [sessResp, rooms, occ, prefsResp] = await Promise.all([
        es().search({ index: INDEX.sessions, size: 1, query: { term: { session_id: sid } } }),
        roomsById(),
        occupancy(),
        req.query.device ? es().get({ index: INDEX.prefs, id: t.pseudonym(req.query.device) }, { ignore: [404] }) : null,
      ]);
      const session = sessResp.hits.hits[0]?._source;
      if (!session) return res.status(404).json({ error: 'not found' });
      const prefs = prefsResp?.found ? prefsResp._source : {};
      const room = rooms[session.room_id];
      const inside = occ[session.room_id] ?? 0;
      const full = room ? inside / room.capacity >= q.FULL : false;
      span.setAttributes({ 'conference.room.id': session.room_id, 'overflow.room_full': full });
      // Candidate window: talks that start within 15 minutes either side of this one.
      const start = new Date(session.start).getTime();
      const window = { from: new Date(start - 15 * 60000).toISOString(), to: new Date(start + 15 * 60000).toISOString(), excludeSession: sid };
      const like = `${session.title}. ${session.abstract}`;
      const built = q.searchBody(like, 'semantic', window, Boolean(SEMANTIC), 20);
      const cand = await t.inSpan('semantic candidates', { 'search.mode': built.mode }, () => es().search({ index: INDEX.sessions, ...built.body }));
      const ranked = await t.inSpan('rank overflow', {}, async () =>
        q.rankOverflow(cand.hits.hits.map((h) => ({ session: h._source, score: h._score ?? 0 })), rooms, occ, room, prefs));
      span.setAttribute('overflow.recommendations.count', ranked.length);
      if (full) t.redirects.add(1, { 'conference.room.id': session.room_id });
      res.json({ session, room, inside, full, recommendations: ranked });
    });
  }));

  // Threat signals from the door kiosks (kiosk/detect.py). Stored for the organizer view.
  app.post('/api/signals', wrap(async (req, res) => {
    const b = req.body ?? {};
    const doc = {
      '@timestamp': new Date().toISOString(), kiosk_id: id(b.kiosk_id, 'kiosk_id'),
      kind: ['new_port', 'new_peer', 'new_hot_function'].includes(b.kind) ? b.kind : 'unknown',
      port: Number(b.port) || null, peer: typeof b.peer === 'string' ? b.peer.slice(0, 64) : null,
      process: typeof b.process === 'string' ? b.process.slice(0, 64) : null, cpu_cores: Number(b.cpu_cores) || null,
      top_function: typeof b.top_function === 'string' ? b.top_function.slice(0, 128) : null,
    };
    t.annotate({ 'signal.kind': doc.kind });
    await es().index({ index: INDEX.signals, document: doc });
    res.status(201).json({ ok: true });
  }));

  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '5m' }));
}

const server = app.listen(PORT, () => console.log(JSON.stringify({ level: 'info', msg: `overflow ${ROLE} listening`, port: PORT, version: VERSION, semantic: Boolean(SEMANTIC) })));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
