// Create indices and load the schedule. Idempotent: safe to run on every deploy
// (deploy/ingest-job.yaml runs it as an Argo CD PostSync hook).
//   node src/ingest.js            create missing indices, (re)load rooms + sessions
//   node src/ingest.js --reset    drop and recreate everything (also clears check-ins)
// Session times in data/sessions.json are slots relative to now, so the overflow
// window always has live candidates in a demo. Real schedule: replace data/*.json.
const fs = require('node:fs');
const path = require('node:path');
const { es, INDEX, SEMANTIC } = require('./es');

const read = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', f), 'utf8'));

const sessionsMapping = () => ({
  properties: {
    session_id: { type: 'keyword' },
    title: { type: 'text', fields: { raw: { type: 'keyword' } } },
    abstract: { type: 'text', ...(SEMANTIC ? { copy_to: 'abstract_semantic' } : {}) },
    ...(SEMANTIC ? { abstract_semantic: { type: 'semantic_text', inference_id: SEMANTIC } } : {}),
    plain_summary: { type: 'text' },
    speakers: { type: 'text', fields: { raw: { type: 'keyword' } } },
    track: { type: 'keyword' },
    level: { type: 'keyword' },
    tags: { type: 'keyword' },
    language: { type: 'keyword' },
    room_id: { type: 'keyword' },
    start: { type: 'date' },
    end: { type: 'date' },
    captions: { type: 'boolean' },
    recorded: { type: 'boolean' },
    sample: { type: 'boolean' },
  },
});

const MAPPINGS = {
  [INDEX.rooms]: {
    properties: {
      room_id: { type: 'keyword' }, name: { type: 'text', fields: { raw: { type: 'keyword' } } }, capacity: { type: 'integer' },
      location: { type: 'geo_point' }, floor: { type: 'integer' }, step_free: { type: 'boolean' }, quiet_room: { type: 'boolean' }, sample: { type: 'boolean' },
    },
  },
  [INDEX.prefs]: {
    properties: {
      device_hash: { type: 'keyword' }, step_free: { type: 'boolean' }, captions: { type: 'boolean' },
      sensory_friendly: { type: 'boolean' }, language: { type: 'keyword' }, updated_at: { type: 'date' },
    },
  },
  [INDEX.queries]: {
    properties: { '@timestamp': { type: 'date' }, q: { type: 'text', fields: { raw: { type: 'keyword', ignore_above: 200 } } }, mode: { type: 'keyword' }, results: { type: 'integer' }, zero_results: { type: 'boolean' } },
  },
  [INDEX.signals]: {
    properties: {
      '@timestamp': { type: 'date' }, kiosk_id: { type: 'keyword' }, kind: { type: 'keyword' }, port: { type: 'integer' }, peer: { type: 'keyword' },
      process: { type: 'keyword' }, cpu_cores: { type: 'float' }, top_function: { type: 'keyword' },
    },
  },
};

async function ensureIndex(name, mappings, reset) {
  const exists = await es().indices.exists({ index: name });
  if (exists && reset) await es().indices.delete({ index: name });
  if (!exists || reset) await es().indices.create({ index: name, mappings });
}

async function ensureCheckinStream(reset) {
  await es().indices.putIndexTemplate({
    name: 'checkins',
    index_patterns: [INDEX.checkins],
    data_stream: {},
    priority: 500,
    template: {
      mappings: {
        properties: {
          '@timestamp': { type: 'date' }, room_id: { type: 'keyword' }, session_id: { type: 'keyword' },
          device_hash: { type: 'keyword' }, direction: { type: 'keyword' }, source: { type: 'keyword' },
        },
      },
    },
  });
  if (reset) await es().indices.deleteDataStream({ name: INDEX.checkins }, { ignore: [404] });
  // Create it now so reads work before the first check-in.
  await es().indices.createDataStream({ name: INDEX.checkins }, { ignore: [400] }); // 400 = already exists
}

function withTimes(sessions) {
  // Slot 0 starts at the current half hour, slot 1 thirty minutes later.
  const now = new Date();
  now.setUTCSeconds(0, 0);
  now.setUTCMinutes(now.getUTCMinutes() < 30 ? 0 : 30);
  return sessions.map(({ slot, duration_min: d, ...s }) => {
    const start = new Date(now.getTime() + slot * 30 * 60000);
    return { ...s, start: start.toISOString(), end: new Date(start.getTime() + d * 60000).toISOString() };
  });
}

async function bulk(index, docs, idField) {
  const operations = docs.flatMap((d) => [{ index: { _index: index, _id: d[idField] } }, d]);
  const r = await es().bulk({ refresh: 'wait_for', operations });
  if (r.errors) {
    const first = r.items.find((i) => i.index?.error);
    throw new Error(`bulk ${index}: ${JSON.stringify(first.index.error).slice(0, 300)}`);
  }
  return docs.length;
}

async function main() {
  const reset = process.argv.includes('--reset');
  // Sessions mapping changes with SEMANTIC, so recreate it when the semantic field is missing.
  let resetSessions = reset;
  if (!reset && SEMANTIC && (await es().indices.exists({ index: INDEX.sessions }))) {
    const m = await es().indices.getMapping({ index: INDEX.sessions });
    resetSessions = !m[INDEX.sessions]?.mappings?.properties?.abstract_semantic;
  }
  await ensureIndex(INDEX.sessions, sessionsMapping(), resetSessions);
  for (const [name, mappings] of Object.entries(MAPPINGS)) await ensureIndex(name, mappings, reset);
  await ensureCheckinStream(reset);
  const rooms = await bulk(INDEX.rooms, read('rooms.json'), 'room_id');
  const sessions = await bulk(INDEX.sessions, withTimes(read('sessions.json')), 'session_id');
  console.log(JSON.stringify({ level: 'info', msg: 'ingest done', rooms, sessions, semantic: SEMANTIC || null, reset }));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(JSON.stringify({ level: 'error', msg: err.message }));
    process.exit(1);
  });
}

module.exports = { withTimes, sessionsMapping };
