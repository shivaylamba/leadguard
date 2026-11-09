// Pure query builders and ranking: no I/O, so they're unit-tested (test/queries.test.js).

const KEYWORD_FIELDS = ['title^3', 'speakers^2', 'tags^2', 'track', 'abstract'];

// filters: { from, to } ISO times, captions (bool), roomIds (array)
function sessionFilters(f = {}) {
  const out = [];
  if (f.from || f.to) out.push({ range: { start: { ...(f.from && { gte: f.from }), ...(f.to && { lte: f.to }) } } });
  if (f.captions) out.push({ term: { captions: true } });
  if (f.roomIds) out.push({ terms: { room_id: f.roomIds } });
  if (f.excludeSession) out.push({ bool: { must_not: { term: { session_id: f.excludeSession } } } });
  return out;
}

function keywordQuery(q, filter) {
  return { bool: { must: { multi_match: { query: q, fields: KEYWORD_FIELDS, fuzziness: 'AUTO' } }, filter } };
}

function semanticQuery(q, filter) {
  return { bool: { must: { semantic: { field: 'abstract_semantic', query: q } }, filter } };
}

// mode: keyword | semantic | hybrid. Semantic modes need an inference endpoint;
// without one they fall back to keyword and the caller records search.mode=keyword.
function searchBody(q, mode, filters, semanticEnabled, size = 10) {
  const filter = sessionFilters(filters);
  const effective = semanticEnabled ? mode : 'keyword';
  const source = { excludes: ['abstract_semantic'] };
  if (effective === 'keyword') return { mode: effective, body: { size, query: keywordQuery(q, filter), _source: source } };
  if (effective === 'semantic') return { mode: effective, body: { size, query: semanticQuery(q, filter), _source: source } };
  return {
    mode: 'hybrid',
    body: {
      size,
      _source: source,
      retriever: {
        rrf: {
          retrievers: [
            { standard: { query: keywordQuery(q, filter) } },
            { standard: { query: semanticQuery(q, filter) } },
          ],
        },
      },
    },
  };
}

// Occupancy for all rooms in ONE aggregation (in +1, out -1 over the window).
function occupancyAgg(sinceIso) {
  return {
    size: 0,
    query: { range: { '@timestamp': { gte: sinceIso } } },
    aggs: {
      rooms: {
        terms: { field: 'room_id', size: 200 },
        aggs: { inside: { sum: { script: { source: "doc['direction'].value == 'in' ? 1 : -1" } } } },
      },
    },
  };
}

function occupancyFromAgg(resp) {
  const out = {};
  for (const b of resp.aggregations?.rooms?.buckets ?? []) out[b.key] = Math.max(0, Math.round(b.inside.value));
  return out;
}

// Equirectangular distance in metres: plenty for one building.
function metres(a, b) {
  if (!a || !b) return null;
  const R = 6371000;
  const x = ((b.lon - a.lon) * Math.PI) / 180 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  const y = ((b.lat - a.lat) * Math.PI) / 180;
  return Math.round(Math.sqrt(x * x + y * y) * R);
}

const FULL = 0.95; // a room at 95% is full for recommending purposes
// Sensory-friendly attendees get rooms under 70%; everyone else under 85%.
function seatLimit(prefs) {
  return prefs?.sensory_friendly ? 0.7 : 0.85;
}

// candidates: [{ session, score }], rooms: { id: room }, occ: { id: count }
function rankOverflow(candidates, rooms, occ, fromRoom, prefs = {}, limit = 3) {
  const out = [];
  for (const { session, score } of candidates) {
    const room = rooms[session.room_id];
    if (!room) continue;
    const inside = occ[session.room_id] ?? 0;
    const load = inside / room.capacity;
    if (load >= seatLimit(prefs)) continue;
    if (prefs.step_free && !room.step_free) continue;
    if (prefs.captions && !session.captions) continue;
    const dist = metres(fromRoom?.location, room.location);
    const walk = dist == null ? null : Math.max(1, Math.round(dist / 80)); // ~80 m per minute
    const reasons = ['similar topic'];
    if (walk != null) reasons.push(`${walk} min walk`);
    reasons.push(`${room.capacity - inside} seats free`);
    if (room.step_free) reasons.push('step-free');
    if (session.captions) reasons.push('captions');
    // Similarity first, then distance as a gentle tie-breaker.
    out.push({ session, room, inside, load, walk, reasons, rank: score - (dist ?? 0) / 10000 });
  }
  return out.sort((a, b) => b.rank - a.rank).slice(0, limit);
}

module.exports = { searchBody, sessionFilters, occupancyAgg, occupancyFromAgg, rankOverflow, metres, FULL, seatLimit };
