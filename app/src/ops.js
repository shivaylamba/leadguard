// Organizer ops: an MCP server for AURA (the AI SRE) and the "Ask ops" API.
//
// AURA runs as its own Deployment (deploy/ops.yaml) and reaches these tools at http://app/mcp
// with a bearer token. Tools return evidence, never personal data: counts, times, booth ids and
// pseudonymised badges only, because whatever a tool returns is sent to the model provider.
// The one write tool only *drafts* a sponsor message; an organizer approves it in the UI.
const crypto = require('node:crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const { es, INDEX } = require('./es');
const m = require('./model');
const t = require('./telemetry');

const MCP_TOKEN = process.env.MCP_TOKEN || '';
const AURA_URL = process.env.AURA_URL || 'http://aura:8090';
const DRAFTS = 'drafts';
const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 1) }] });

async function boothTimeline(booth, minutes) {
  const since = `now-${minutes}m`;
  const [scans, scanners, anomalies] = await Promise.all([
    es().search({
      index: INDEX.scans, size: 0, ignore_unavailable: true,
      query: { bool: { filter: [{ term: { booth_id: booth } }, { range: { scanned_at: { gte: since } } }] } },
      aggs: {
        per_5m: { date_histogram: { field: 'scanned_at', fixed_interval: '5m', min_doc_count: 0, extended_bounds: { min: since, max: 'now' } } },
        // Scans received long after they were made: the device was offline and synced later.
        late: { filter: { term: { clock: 'queued' } }, aggs: { max_skew: { min: { field: 'skew_ms' } }, first: { min: { field: 'scanned_at' } }, last: { max: { field: 'scanned_at' } } } },
        outcomes: { terms: { field: 'clock' } },
      },
    }),
    es().search({ index: INDEX.scanners, size: 20, ignore_unavailable: true, query: { term: { booth_id: booth } } }),
    es().search({ index: INDEX.anomalies, size: 50, ignore_unavailable: true, query: { term: { booth_id: booth } }, sort: [{ first_detected: 'desc' }] }),
  ]);
  const late = scans.aggregations?.late;
  return {
    booth_id: booth, window_minutes: minutes, venue_tz: m.VENUE_TZ,
    scans_per_5min: (scans.aggregations?.per_5m?.buckets ?? []).map((b) => ({ at: b.key_as_string, scans: b.doc_count })),
    synced_late: late?.doc_count ? { scans: late.doc_count, made_between: [late.first.value_as_string, late.last.value_as_string], max_delay_minutes: Math.round(Math.abs(late.max_skew.value || 0) / 60000) } : null,
    scanners: scanners.hits.hits.map((h) => ({ scanner_id: h._source.scanner_id, last_seen: h._source.last_seen, queue_depth: h._source.queue_depth, queue_since: h._source.queue_since })),
    anomalies: anomalies.hits.hits.map((h) => ({ kind: h._source.kind, status: h._source.status, first_detected: h._source.first_detected, last_seen: h._source.last_seen, resolved_at: h._source.resolved_at ?? null, badge: h._source.badge_id ? t.pseudonym(h._source.badge_id) : null, detail: h._source.detail, explain: m.EXPLAIN[h._source.kind] })),
  };
}

function buildMcp() {
  const server = new McpServer({ name: 'leadguard', version: '0.2.0' });
  server.registerTool('get_booth_health', {
    description: 'Every booth: number of leads and consented leads, time of the last lead, scanners (last heartbeat, queued scans) and open anomalies. Start here.',
    inputSchema: {},
  }, async () => {
    const [booths, leads, scanners, open] = await Promise.all([
      es().search({ index: INDEX.booths, size: 100 }),
      es().search({ index: INDEX.leads, size: 0, ignore_unavailable: true, aggs: { b: { terms: { field: 'booth_id', size: 100 }, aggs: { consented: { filter: { term: { consent: true } } }, last: { max: { field: 'last_seen' } } } } } }),
      es().search({ index: INDEX.scanners, size: 200, ignore_unavailable: true }),
      es().search({ index: INDEX.anomalies, size: 0, ignore_unavailable: true, query: { term: { status: 'open' } }, aggs: { b: { terms: { field: 'booth_id', size: 100 }, aggs: { k: { terms: { field: 'kind' } } } } } }),
    ]);
    const by = (r) => Object.fromEntries((r.aggregations?.b?.buckets ?? []).map((b) => [b.key, b]));
    const L = by(leads), A = by(open);
    const sc = scanners.hits.hits.map((h) => h._source);
    return text(booths.hits.hits.map((h) => {
      const b = h._source;
      return {
        booth_id: b.booth_id, sponsor: b.sponsor, leads: L[b.booth_id]?.doc_count ?? 0, consented: L[b.booth_id]?.consented.doc_count ?? 0,
        last_lead: L[b.booth_id]?.last.value_as_string ?? null,
        scanners: sc.filter((s) => s.booth_id === b.booth_id).map((s) => ({ scanner_id: s.scanner_id, last_seen: s.last_seen, queue_depth: s.queue_depth })),
        open_anomalies: Object.fromEntries((A[b.booth_id]?.k.buckets ?? []).map((k) => [k.key, k.doc_count])),
      };
    }));
  });
  server.registerTool('get_booth_timeline', {
    description: 'Evidence for one booth over the last N minutes: scans per 5 minutes (gaps = nothing scanned), scans that were made offline and synced late, scanner heartbeats and queue, and every anomaly (open and resolved) with times. Use it to answer "what happened at booth X".',
    inputSchema: { booth_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), minutes: z.number().int().min(15).max(720).default(180) },
  }, async ({ booth_id, minutes }) => text(await boothTimeline(booth_id, minutes ?? 180)));
  server.registerTool('list_anomalies', {
    description: 'Integrity anomalies (open or resolved): leads for badges that never checked in, scans before check-in, shared badges at two booths, silent booths, offline scanners, scans not syncing. Badges are pseudonymised.',
    inputSchema: { status: z.enum(['open', 'resolved']).default('open') },
  }, async ({ status }) => {
    const r = await es().search({ index: INDEX.anomalies, size: 100, ignore_unavailable: true, query: { term: { status: status ?? 'open' } }, sort: [{ last_seen: 'desc' }] });
    return text(r.hits.hits.map((h) => ({ kind: h._source.kind, booth_id: h._source.booth_id, badge: h._source.badge_id ? t.pseudonym(h._source.badge_id) : null, scanner_id: h._source.scanner_id, first_detected: h._source.first_detected, last_seen: h._source.last_seen, detail: h._source.detail, explain: m.EXPLAIN[h._source.kind] })));
  });
  server.registerTool('get_checkin_stats', {
    description: 'Registration desks: total checked in, check-ins per minute over the last 60 minutes, per desk, and re-entries.',
    inputSchema: {},
  }, async () => {
    const [ci, total] = await Promise.all([
      es().search({ index: INDEX.checkins, size: 0, ignore_unavailable: true, query: { range: { '@timestamp': { gte: 'now-60m' } } }, aggs: { per_min: { date_histogram: { field: '@timestamp', fixed_interval: '5m' } }, desks: { terms: { field: 'desk_id' } } } }),
      es().count({ index: INDEX.checkedIn, ignore_unavailable: true }),
    ]);
    return text({ checked_in: total.count, last_60_min_per_5min: (ci.aggregations?.per_min?.buckets ?? []).map((b) => ({ at: b.key_as_string, n: b.doc_count })), desks: (ci.aggregations?.desks?.buckets ?? []).map((b) => ({ desk_id: b.key, n: b.doc_count })) });
  });
  server.registerTool('get_ticket_risk_summary', {
    description: 'People not yet checked in whose ticket email bounced, was marked as spam, or never arrived: counts by reason and by email domain (no names). A domain with many bounces points at a corporate mail filter.',
    inputSchema: {},
  }, async () => {
    const r = await es().search({ index: INDEX.attendees, size: 0, query: { terms: { 'ticket_email.status': ['bounced', 'complained', 'sent'] } }, aggs: { status: { terms: { field: 'ticket_email.status' } }, domains: { terms: { script: { source: "def e = doc['emails'].size() > 0 ? doc['emails'][0] : ''; int i = e.indexOf('@'); return i < 0 ? '' : e.substring(i + 1);" }, size: 10 } } } });
    return text({ by_status: (r.aggregations.status.buckets).map((b) => ({ status: b.key, n: b.doc_count })), by_domain: r.aggregations.domains.buckets.map((b) => ({ domain: b.key, n: b.doc_count })) });
  });
  server.registerTool('draft_sponsor_message', {
    description: 'Draft a message to a sponsor about their booth (for example an explanation of an outage with the evidence). It is NOT sent: it waits for an organizer to approve it in LeadGuard. Use plain, factual language and the venue time zone.',
    inputSchema: { booth_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), subject: z.string().min(3).max(200), body: z.string().min(10).max(4000) },
  }, async ({ booth_id, subject, body }) => {
    const id = crypto.randomUUID();
    await es().index({ index: DRAFTS, id, refresh: 'wait_for', document: { booth_id, subject, body, status: 'awaiting_approval', created_at: new Date().toISOString(), author: 'aura' } });
    t.annotate({ 'leadguard.booth.id': booth_id, 'leadguard.draft.id': id });
    return text({ draft_id: id, status: 'awaiting_approval', note: 'An organizer must approve this in LeadGuard before anything is sent.' });
  });
  return server;
}

function mount(app, wrap) {
  // MCP for AURA. Stateless streamable HTTP; bearer token from Secret app-credentials.
  app.post('/mcp', async (req, res) => {
    if (!MCP_TOKEN || req.get('authorization') !== `Bearer ${MCP_TOKEN}`) return res.status(401).json({ error: 'unauthorized' });
    const server = buildMcp();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', msg: `mcp: ${err.message}` }));
      if (!res.headersSent) res.status(500).json({ error: 'mcp error' });
    }
  });
  for (const verb of ['get', 'delete']) app[verb]('/mcp', (_req, res) => res.status(405).json({ error: 'stateless MCP: POST only' }));

  // "Ask ops": the organizer asks AURA a question in plain language.
  app.post('/api/ops/ask', wrap(async (req, res) => {
    const question = String(req.body?.question ?? '').trim().slice(0, 1000);
    if (question.length < 3) return res.status(400).json({ error: 'ask a question' });
    const r = await t.inSpan('ask aura', {}, () => fetch(`${AURA_URL}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(180000),
      body: JSON.stringify({ model: 'leadguard-ops', stream: false, messages: [{ role: 'user', content: question }] }),
    }));
    if (!r.ok) return res.status(502).json({ error: `assistant unavailable (${r.status})` });
    const out = await r.json();
    res.json({ answer: out.choices?.[0]?.message?.content ?? '' });
  }));

  app.get('/api/ops/drafts', wrap(async (_req, res) => {
    const r = await es().search({ index: DRAFTS, size: 50, ignore_unavailable: true, sort: [{ created_at: 'desc' }] });
    res.json({ drafts: r.hits.hits.map((h) => ({ id: h._id, ...h._source })) });
  }));

  // Approving marks the draft approved. Sending is not wired to an email provider in this build.
  app.post('/api/ops/drafts/:id/approve', wrap(async (req, res) => {
    const id = String(req.params.id);
    if (!/^[0-9a-f-]{36}$/.test(id)) return res.status(400).json({ error: 'invalid id' });
    await es().update({ index: DRAFTS, id, doc: { status: 'approved', approved_at: new Date().toISOString() } });
    res.json({ ok: true });
  }));
}

module.exports = { mount, buildMcp, boothTimeline };
