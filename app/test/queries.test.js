const test = require('node:test');
const assert = require('node:assert/strict');
const q = require('../src/queries');
const { pseudonym } = require('../src/telemetry');
const { withTimes } = require('../src/ingest');

test('keyword fallback when semantic is not configured', () => {
  const r = q.searchBody('ebpf', 'hybrid', {}, false);
  assert.equal(r.mode, 'keyword');
  assert.ok(r.body.query.bool.must.multi_match);
});

test('hybrid uses an RRF retriever with keyword and semantic legs', () => {
  const r = q.searchBody('ebpf', 'hybrid', { captions: true }, true);
  assert.equal(r.mode, 'hybrid');
  const legs = r.body.retriever.rrf.retrievers;
  assert.equal(legs.length, 2);
  assert.ok(legs[1].standard.query.bool.must.semantic);
  assert.deepEqual(legs[0].standard.query.bool.filter, [{ term: { captions: true } }]);
});

test('occupancy counts ins minus outs and never goes negative', () => {
  const occ = q.occupancyFromAgg({ aggregations: { rooms: { buckets: [{ key: 'a', inside: { value: 12 } }, { key: 'b', inside: { value: -3 } }] } } });
  assert.deepEqual(occ, { a: 12, b: 0 });
});

const rooms = {
  full: { room_id: 'full', capacity: 10, step_free: true, location: { lat: 40.7637, lon: -111.8955 } },
  near: { room_id: 'near', capacity: 100, step_free: true, location: { lat: 40.7638, lon: -111.8955 } },
  stairs: { room_id: 'stairs', capacity: 100, step_free: false, location: { lat: 40.7637, lon: -111.8956 } },
  busy: { room_id: 'busy', capacity: 100, step_free: true, location: { lat: 40.7637, lon: -111.8954 } },
};
const cand = [
  { session: { session_id: 'b', room_id: 'busy', captions: true }, score: 9 },
  { session: { session_id: 's', room_id: 'stairs', captions: true }, score: 8 },
  { session: { session_id: 'n', room_id: 'near', captions: false }, score: 7 },
];

test('overflow skips rooms at or above the seat limit', () => {
  const out = q.rankOverflow(cand, rooms, { busy: 90 }, rooms.full);
  assert.deepEqual(out.map((x) => x.session.session_id), ['s', 'n']);
});

test('overflow honours step-free and captions needs', () => {
  assert.deepEqual(q.rankOverflow(cand, rooms, {}, rooms.full, { step_free: true }).map((x) => x.session.session_id), ['b', 'n']);
  assert.deepEqual(q.rankOverflow(cand, rooms, {}, rooms.full, { step_free: true, captions: true }).map((x) => x.session.session_id), ['b']);
});

test('sensory-friendly lowers the seat limit to 70%', () => {
  assert.deepEqual(q.rankOverflow(cand, rooms, { busy: 75 }, rooms.full, { sensory_friendly: true }).map((x) => x.session.session_id), ['s', 'n']);
});

test('pseudonyms are stable, short and never the raw id', () => {
  assert.equal(pseudonym('device-1'), pseudonym('device-1'));
  assert.notEqual(pseudonym('device-1'), 'device-1');
  assert.equal(pseudonym('device-1').length, 16);
  assert.equal(pseudonym(undefined), 'anonymous');
});

test('sample sessions get slot times relative to now', () => {
  const [a, b] = withTimes([{ session_id: 'x', slot: 0, duration_min: 30 }, { session_id: 'y', slot: 1, duration_min: 30 }]);
  assert.equal(new Date(b.start) - new Date(a.start), 30 * 60000);
  assert.equal(new Date(a.end) - new Date(a.start), 30 * 60000);
  assert.ok(!('slot' in a));
});
