const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../src/model');
const { pseudonym } = require('../src/telemetry');
const { synthetic, BOOTHS } = require('../src/seed');

test('expo hours are judged in the venue time zone, not the server zone', () => {
  // 16:30 UTC is 09:30 in Salt Lake City (MST, UTC-7) on 9 Nov 2026.
  assert.equal(m.isExpoOpen(new Date('2026-11-09T16:30:00Z'), '09:00-18:00', 'America/Denver'), true);
  // 01:30 UTC next day is 18:30 the evening before in Denver: closed.
  assert.equal(m.isExpoOpen(new Date('2026-11-10T01:30:00Z'), '09:00-18:00', 'America/Denver'), false);
  // Same instant in Zurich is 02:30: closed there too, for a different reason.
  assert.equal(m.isExpoOpen(new Date('2026-11-10T01:30:00Z'), '09:00-18:00', 'Europe/Zurich'), false);
  assert.equal(m.isExpoOpen(new Date(), ''), true);
  assert.throws(() => m.isExpoOpen(new Date(), '9-18'));
});

test('scanner clocks: future times and day-old times fall back to receipt time', () => {
  const rx = new Date('2026-11-09T18:00:00Z');
  assert.equal(m.scanTime('2026-11-09T17:59:30Z', rx).clock, 'ok');
  assert.equal(m.scanTime('2026-11-09T17:30:00Z', rx).clock, 'queued'); // offline queue, synced later
  assert.deepEqual(m.scanTime('2026-11-09T19:00:00Z', rx).at, rx.toISOString());
  assert.equal(m.scanTime('2026-11-09T19:00:00Z', rx).clock, 'future');
  assert.equal(m.scanTime('2026-11-07T18:00:00Z', rx).clock, 'stale');
  assert.equal(m.scanTime('not a date', rx).clock, 'missing');
});

test('scan validation requires ids, consent and a timestamp string', () => {
  assert.ok(m.validScan({ scan_id: 's1', badge_id: 'B1', consent: true, scanned_at: '2026-11-09T18:00:00Z' }));
  assert.ok(!m.validScan({ scan_id: 's1', badge_id: 'B1', scanned_at: '2026-11-09T18:00:00Z' }));
  assert.ok(!m.validScan({ scan_id: 'bad id!', badge_id: 'B1', consent: true, scanned_at: 'x' }));
  assert.ok(!m.validScan({ scan_id: 's1', badge_id: 'B1', consent: true, scanned_at: 'x', notes: 'x'.repeat(1001) }));
});

test('desk search covers every linked email, order id and fuzzy name', () => {
  const q = m.attendeeSearch('Mira.Keller@Personal.example');
  const should = q.query.bool.should;
  assert.ok(should.some((c) => c.term?.emails?.value === 'mira.keller@personal.example'));
  assert.ok(should.some((c) => c.multi_match?.fuzziness === 'AUTO'));
  assert.ok(m.attendeeSearch('ord-50002').query.bool.should.some((c) => c.term?.order_id?.value === 'ORD-50002'));
});

test('ticket email risk: bounced, spam and never-delivered are at risk', () => {
  const now = new Date('2026-11-09T18:00:00Z');
  assert.equal(m.ticketEmailRisk({ status: 'bounced', detail: '550' }, now).at_risk, true);
  assert.equal(m.ticketEmailRisk({ status: 'complained' }, now).reason, 'marked as spam');
  assert.equal(m.ticketEmailRisk({ status: 'sent', at: '2026-11-08T08:00:00Z' }, now).at_risk, true);
  assert.equal(m.ticketEmailRisk({ status: 'sent', at: '2026-11-09T17:00:00Z' }, now).at_risk, false);
  assert.equal(m.ticketEmailRisk({ status: 'opened' }, now).at_risk, false);
  assert.equal(m.ticketEmailRisk(undefined, now).at_risk, true);
});

const booths = Object.fromEntries(BOOTHS.map((b) => [b.booth_id, b]));
test('impossible travel: far booths seconds apart, but not slow walks or the same booth', () => {
  const s = (badge, booth, at) => ({ badge_id: badge, booth_id: booth, scanned_at: at });
  const out = m.impossibleTravel([
    s('B1', 'dash0', '2026-11-09T18:00:00Z'), s('B1', 'demo', '2026-11-09T18:00:15Z'), // ~110 m in 15 s
    s('B2', 'dash0', '2026-11-09T18:00:00Z'), s('B2', 'demo', '2026-11-09T18:05:00Z'), // 5 min: fine
    s('B3', 'dash0', '2026-11-09T18:00:00Z'), s('B3', 'dash0', '2026-11-09T18:00:05Z'), // same booth
  ], booths);
  assert.deepEqual(out.map((a) => a.badge_id), ['B1']);
  assert.ok(out[0].metres > 80);
});

test('booth health: silent booths, offline scanners and stuck queues', () => {
  const now = new Date('2026-11-09T18:00:00Z');
  const out = m.boothHealth(
    [{ booth_id: 'dash0', scans_last_hour: 40, last_scan: '2026-11-09T17:40:00Z' }, { booth_id: 'sonar', scans_last_hour: 12, last_scan: '2026-11-09T17:58:00Z' }, { booth_id: 'radar', scans_last_hour: 0, last_scan: null }],
    [{ scanner_id: 's-a', booth_id: 'elastic', last_seen: '2026-11-09T17:50:00Z', queue_depth: 7 }, { scanner_id: 's-b', booth_id: 'sonar', last_seen: '2026-11-09T17:59:50Z', queue_depth: 3, queue_since: '2026-11-09T17:50:00Z' }],
    now,
  );
  assert.deepEqual(out.map((a) => `${a.kind}:${a.booth_id}`).sort(), ['scanner_offline:elastic', 'scans_not_syncing:sonar', 'silent_booth:dash0']);
  assert.deepEqual(m.boothHealth([{ booth_id: 'dash0', scans_last_hour: 40, last_scan: '2026-11-09T17:00:00Z' }], [], now, { expoOpen: false }), []);
});

test('anomaly ids are deterministic so re-detection never duplicates', () => {
  const a = { kind: 'never_checked_in', booth_id: 'dash0', badge_id: 'B20001' };
  assert.equal(m.anomalyId(a), m.anomalyId({ ...a }));
  assert.notEqual(m.anomalyId(a), m.anomalyId({ ...a, booth_id: 'sonar' }));
  for (const k of ['never_checked_in', 'scanned_before_checkin', 'impossible_travel', 'silent_booth', 'scanner_offline', 'scans_not_syncing']) assert.ok(m.EXPLAIN[k]);
});

test('ES|QL integrity query joins scans to check-ins', () => {
  const q = m.integrityEsql(60);
  assert.match(q, /LOOKUP JOIN checked_in ON badge_id/);
  assert.match(q, /never_checked_in/);
  assert.match(q, /NOW\(\) - 60 minutes/);
});

test('synthetic attendees are deterministic, unique and use example domains only', () => {
  const a = synthetic(50), b = synthetic(50);
  assert.deepEqual(a, b);
  assert.equal(new Set(a.map((x) => x.badge_id)).size, 50);
  assert.ok(a.every((x) => x.emails.every((e) => /@[a-z]+\.example$/.test(e))));
});

test('pseudonyms are stable and never the raw id', () => {
  assert.equal(pseudonym('B10001'), pseudonym('B10001'));
  assert.notEqual(pseudonym('B10001'), 'B10001');
  assert.equal(pseudonym(undefined), 'anonymous');
});
