// LeadGuard domain logic: pure functions, no I/O, unit-tested in test/model.test.js.
//
// The rule LeadGuard enforces: a sponsor's leads are a subset of the people who
// actually checked in. Anything that breaks it is an anomaly an organizer sees
// before the sponsor complains.

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const isId = (v) => typeof v === 'string' && ID.test(v);

// ── time (see .gitar/review/time.md) ───────────────────────────────────────
// Every stored timestamp is an ISO-8601 instant in UTC. The venue zone is only
// used to decide "is the expo open" and to render times for humans.
const VENUE_TZ = process.env.VENUE_TZ || 'America/Denver';

// Minutes since local midnight in `tz` for the instant `date`.
function localMinutes(date, tz = VENUE_TZ) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === 'hour').value);
  const m = Number(parts.find((p) => p.type === 'minute').value);
  return h * 60 + m;
}

// hours: "09:00-18:00" in venue local time; empty string = always open.
function isExpoOpen(date, hours = process.env.EXPO_HOURS || '', tz = VENUE_TZ) {
  if (!hours) return true;
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(hours);
  if (!m) throw new Error(`EXPO_HOURS must look like 09:00-18:00, got ${hours}`);
  const open = Number(m[1]) * 60 + Number(m[2]);
  const close = Number(m[3]) * 60 + Number(m[4]);
  const now = localMinutes(date, tz);
  return open <= close ? now >= open && now < close : now >= open || now < close;
}

// A scanner's clock can be wrong. Trust its time only within the allowed skew of
// when the server received the scan; otherwise use the receive time and say so.
const MAX_SKEW_MS = 10 * 60 * 1000;
function scanTime(deviceIso, receivedAt) {
  const device = Date.parse(deviceIso);
  if (Number.isNaN(device)) return { at: receivedAt.toISOString(), clock: 'missing' };
  const skew = device - receivedAt.getTime();
  if (skew > 60 * 1000) return { at: receivedAt.toISOString(), clock: 'future', skew_ms: skew }; // can't scan in the future
  if (-skew > 24 * 3600 * 1000) return { at: receivedAt.toISOString(), clock: 'stale', skew_ms: skew }; // a day-old queue is suspect
  return { at: new Date(device).toISOString(), clock: Math.abs(skew) > MAX_SKEW_MS ? 'queued' : 'ok', skew_ms: skew };
}

// ── input validation ───────────────────────────────────────────────────────
function validScan(s) {
  return s && isId(s.scan_id) && isId(s.badge_id) && typeof s.consent === 'boolean' && typeof s.scanned_at === 'string'
    && (s.notes === undefined || (typeof s.notes === 'string' && s.notes.length <= 1000));
}

const leadId = (boothId, badgeId) => `${boothId}:${badgeId}`;

// Fold a batch's scans for one booth+badge into the lead record. Pure, so the ingest path can
// read-merge-write (semantic_text indices don't allow scripted updates) and tests can pin it.
// Contact details are copied only with consent; once consent is given it isn't silently revoked.
// Idempotent by scan_id: a retried batch (scans already stored, lead write failed) repairs the
// lead without double-counting.
function mergeLead(existing, scans, person, booth, badge) {
  const sorted = [...scans].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const lead = existing ? { ...existing, scan_ids: [...(existing.scan_ids || [])] } : {
    booth_id: booth, badge_id: badge, known_attendee: Boolean(person), first_seen: sorted[0].at, last_seen: sorted[0].at, scan_count: 0, consent: false, notes: '', scan_ids: [],
  };
  for (const s of sorted) {
    if (s.scan_id && lead.scan_ids.includes(s.scan_id)) continue;
    if (s.scan_id) lead.scan_ids.push(s.scan_id);
    lead.scan_count += 1;
    if (Date.parse(s.at) > Date.parse(lead.last_seen)) lead.last_seen = s.at;
    if (Date.parse(s.at) < Date.parse(lead.first_seen)) lead.first_seen = s.at;
    if (s.consent) lead.consent = true;
    if (s.notes) lead.notes = s.notes;
  }
  if (lead.scan_ids.length > 200) lead.scan_ids = lead.scan_ids.slice(-200);
  if (lead.consent && person) Object.assign(lead, { name: person.name, email: person.emails?.[0], company: person.company });
  return lead;
}
const normEmail = (e) => String(e || '').trim().toLowerCase();

// ── desk lookup: find a person who can't find their ticket ───────────────
// The real cases: bought with a work email, changed jobs, now arrives with a personal
// email; misspelt name; ticket email in spam. So we search every email ever linked to
// the attendee, the order id, the name (fuzzy + prefix) and the company, together.
function attendeeSearch(q, size = 8) {
  const text = String(q).trim().slice(0, 100);
  const should = [
    { term: { badge_id: { value: text.toUpperCase(), boost: 20 } } },
    { term: { order_id: { value: text.toUpperCase(), boost: 20 } } },
    { term: { emails: { value: normEmail(text), boost: 15 } } },
    { multi_match: { query: text, fields: ['name^3', 'company'], fuzziness: 'AUTO', prefix_length: 1 } },
    { match: { 'name.prefix': { query: text, boost: 2 } } },
    { match: { 'emails.text': { query: text } } }, // local part or domain: "mira" or "acme.com"
  ];
  return { size, query: { bool: { should, minimum_should_match: 1 } } };
}

// Ticket emails, from the email provider's webhook (sent / delivered / bounced / complained / opened).
// An attendee is at risk if their latest ticket email bounced or was marked spam, or
// was sent more than `quietHours` ago and never delivered.
const EMAIL_STATES = ['sent', 'delivered', 'opened', 'bounced', 'complained'];
function ticketEmailRisk(latest, now, quietHours = 24) {
  if (!latest) return { at_risk: true, reason: 'no ticket email recorded' };
  if (latest.status === 'bounced') return { at_risk: true, reason: `bounced (${latest.detail || 'no detail'})` };
  if (latest.status === 'complained') return { at_risk: true, reason: 'marked as spam' };
  if (latest.status === 'sent' && now.getTime() - Date.parse(latest.at) > quietHours * 3600000) {
    return { at_risk: true, reason: `sent ${Math.round((now.getTime() - Date.parse(latest.at)) / 3600000)} h ago, never delivered` };
  }
  return { at_risk: false, reason: latest.status };
}

// ── detectors ──────────────────────────────────────────────────────────────
// ES|QL: scans whose badge never checked in, or was scanned before it checked in.
// checked_in is a lookup-mode index (badge_id → first_checkin_at) kept by the check-in path.
// Devices and desks disagree by seconds; only a scan clearly before check-in is suspicious.
const CLOCK_TOLERANCE_MIN = 2;
function integrityEsql(windowMin) {
  return `FROM scans
| WHERE @timestamp > NOW() - ${Number(windowMin)} minutes
| LOOKUP JOIN checked_in ON badge_id
| EVAL kind = CASE(first_checkin_at IS NULL, "never_checked_in", scanned_at < first_checkin_at - ${CLOCK_TOLERANCE_MIN} minutes, "scanned_before_checkin", "ok")
| WHERE kind != "ok"
| STATS scans = COUNT(*), first_scan = MIN(scanned_at), last_scan = MAX(scanned_at) BY kind, badge_id, booth_id
| LIMIT 1000`;
}

// Equirectangular metres: plenty for one expo hall.
function metres(a, b) {
  const x = (((b.lon - a.lon) * Math.PI) / 180) * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  const y = ((b.lat - a.lat) * Math.PI) / 180;
  return Math.sqrt(x * x + y * y) * 6371000;
}

// Same badge at two booths faster than anyone walks a crowded hall: a shared or cloned badge.
// scans: [{ badge_id, booth_id, scanned_at }], booths: { id: { location } }
const MAX_WALK_MPS = 2.0;
function impossibleTravel(scans, booths, maxMps = MAX_WALK_MPS) {
  const byBadge = new Map();
  for (const s of scans) (byBadge.get(s.badge_id) || byBadge.set(s.badge_id, []).get(s.badge_id)).push(s);
  const out = [];
  for (const [badge, list] of byBadge) {
    list.sort((a, b) => Date.parse(a.scanned_at) - Date.parse(b.scanned_at));
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1], b = list[i];
      if (a.booth_id === b.booth_id) continue;
      const A = booths[a.booth_id]?.location, B = booths[b.booth_id]?.location;
      if (!A || !B) continue;
      const dist = metres(A, B);
      const secs = Math.max(1, (Date.parse(b.scanned_at) - Date.parse(a.scanned_at)) / 1000);
      if (dist / secs > maxMps) {
        out.push({ kind: 'impossible_travel', badge_id: badge, booth_id: b.booth_id, from_booth: a.booth_id, metres: Math.round(dist), seconds: Math.round(secs) });
      }
    }
  }
  return out;
}

// A booth that was scanning and went quiet, a scanner that stopped reporting, or a
// scanner holding scans it can't sync: the "where are my leads?" complaint, before it happens.
// stats: [{ booth_id, last_scan, scans_last_hour }], scanners: [{ scanner_id, booth_id, last_seen, queue_depth, queue_since }]
function boothHealth(stats, scanners, now, { silentMin = 10, staleMin = 2, queueMin = 5, expoOpen = true } = {}) {
  const t = now.getTime();
  const out = [];
  if (!expoOpen) return out;
  for (const s of stats) {
    if (s.scans_last_hour > 0 && s.last_scan && t - Date.parse(s.last_scan) > silentMin * 60000) {
      out.push({ kind: 'silent_booth', booth_id: s.booth_id, minutes_silent: Math.round((t - Date.parse(s.last_scan)) / 60000) });
    }
  }
  for (const sc of scanners) {
    if (sc.last_seen && t - Date.parse(sc.last_seen) > staleMin * 60000) {
      out.push({ kind: 'scanner_offline', booth_id: sc.booth_id, scanner_id: sc.scanner_id, minutes_offline: Math.round((t - Date.parse(sc.last_seen)) / 60000), queue_depth: sc.queue_depth ?? 0 });
    } else if ((sc.queue_depth ?? 0) > 0 && sc.queue_since && t - Date.parse(sc.queue_since) > queueMin * 60000) {
      out.push({ kind: 'scans_not_syncing', booth_id: sc.booth_id, scanner_id: sc.scanner_id, queue_depth: sc.queue_depth });
    }
  }
  return out;
}

// Deterministic anomaly id: re-running a detector updates the same record, never duplicates it.
const anomalyId = (a) => [a.kind, a.booth_id || '-', a.badge_id || a.scanner_id || '-'].join(':');

const EXPLAIN = {
  never_checked_in: 'Lead scanned for a badge that never checked in: shared or forwarded badge, reused printed badge, or a typo.',
  scanned_before_checkin: 'Lead scanned before the badge checked in: scanner clock wrong, or a badge used before pickup.',
  impossible_travel: 'Same badge at two booths faster than anyone can walk: shared or cloned badge.',
  silent_booth: 'Booth was scanning and has gone quiet: scanner app, battery or Wi-Fi. Leads are probably being lost.',
  scanner_offline: 'Scanner stopped reporting. Scans may be queued on the device.',
  scans_not_syncing: 'Scanner is online but has scans it cannot sync.',
};

module.exports = {
  isId, isExpoOpen, localMinutes, scanTime, validScan, leadId, mergeLead, normEmail, CLOCK_TOLERANCE_MIN, attendeeSearch, ticketEmailRisk, EMAIL_STATES,
  integrityEsql, metres, impossibleTravel, boothHealth, anomalyId, EXPLAIN, VENUE_TZ, MAX_WALK_MPS,
};
