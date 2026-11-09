// Create indices and load the registry. Idempotent: the web role runs it at start-up (no Argo CD
// PostSync hook: hooks wait for every resource to be healthy, and a canary paused for a human
// decision would block every later deploy).
//   node src/seed.js            create what's missing, load booths + attendees if empty
//   node src/seed.js --reset    drop everything (check-ins, scans, leads, anomalies too)
//   node src/seed.js --csv f    import attendees from a registration export instead of synthetic ones
// Synthetic attendees are generated, not real people: emails use example.com / example.net.
const fs = require('node:fs');
const { es, INDEX, SEMANTIC } = require('./es');

const SETTINGS = {
  analysis: {
    analyzer: { prefix: { tokenizer: 'standard', filter: ['lowercase', 'asciifolding', 'edge'] }, folded: { tokenizer: 'standard', filter: ['lowercase', 'asciifolding'] } },
    filter: { edge: { type: 'edge_ngram', min_gram: 2, max_gram: 15 } },
  },
};

const INDICES = {
  [INDEX.attendees]: {
    settings: SETTINGS,
    mappings: {
      properties: {
        badge_id: { type: 'keyword' }, order_id: { type: 'keyword' },
        name: { type: 'text', analyzer: 'folded', fields: { prefix: { type: 'text', analyzer: 'prefix', search_analyzer: 'folded' }, raw: { type: 'keyword' } } },
        emails: { type: 'keyword', normalizer: 'lowercase', fields: { text: { type: 'text', analyzer: 'folded' } } },
        company: { type: 'text', analyzer: 'folded', fields: { raw: { type: 'keyword' } } },
        ticket_type: { type: 'keyword' }, needs_assistance: { type: 'boolean' },
        ticket_email: { properties: { status: { type: 'keyword' }, at: { type: 'date' }, detail: { type: 'keyword' } } },
        synthetic: { type: 'boolean' },
      },
    },
  },
  [INDEX.checkedIn]: { settings: { 'index.mode': 'lookup' }, mappings: { properties: { badge_id: { type: 'keyword' }, first_checkin_at: { type: 'date' } } } },
  [INDEX.booths]: { mappings: { properties: { booth_id: { type: 'keyword' }, sponsor: { type: 'keyword' }, name: { type: 'text' }, location: { type: 'geo_point' }, demo: { type: 'boolean' } } } },
  [INDEX.leads]: {
    mappings: {
      properties: {
        booth_id: { type: 'keyword' }, badge_id: { type: 'keyword' }, known_attendee: { type: 'boolean' }, consent: { type: 'boolean' },
        name: { type: 'text', fields: { raw: { type: 'keyword' } } }, email: { type: 'keyword' }, company: { type: 'text', fields: { raw: { type: 'keyword' } } },
        notes: { type: 'text', ...(SEMANTIC ? { copy_to: 'notes_semantic' } : {}) },
        ...(SEMANTIC ? { notes_semantic: { type: 'semantic_text', inference_id: SEMANTIC } } : {}),
        first_seen: { type: 'date' }, last_seen: { type: 'date' }, scan_count: { type: 'integer' }, scan_ids: { type: 'keyword', index: false },
      },
    },
  },
  [INDEX.scanners]: { mappings: { properties: { scanner_id: { type: 'keyword' }, booth_id: { type: 'keyword' }, last_seen: { type: 'date' }, queue_depth: { type: 'integer' }, queue_since: { type: 'date' }, app_version: { type: 'keyword' } } } },
  [INDEX.anomalies]: {
    mappings: {
      properties: {
        kind: { type: 'keyword' }, booth_id: { type: 'keyword' }, badge_id: { type: 'keyword' }, scanner_id: { type: 'keyword' }, status: { type: 'keyword' },
        detail: { type: 'object', enabled: false }, first_detected: { type: 'date' }, last_seen: { type: 'date' }, resolved_at: { type: 'date' },
      },
    },
  },
  drafts: { mappings: { properties: { booth_id: { type: 'keyword' }, subject: { type: 'text' }, body: { type: 'text' }, status: { type: 'keyword' }, author: { type: 'keyword' }, created_at: { type: 'date' }, approved_at: { type: 'date' } } } },
  [INDEX.signals]: { mappings: { properties: { '@timestamp': { type: 'date' }, kiosk_id: { type: 'keyword' }, kind: { type: 'keyword' }, port: { type: 'integer' }, peer: { type: 'keyword' }, process: { type: 'keyword' }, cpu_cores: { type: 'float' }, top_function: { type: 'keyword' } } } },
};

const STREAMS = {
  [INDEX.checkins]: { '@timestamp': { type: 'date' }, badge_id: { type: 'keyword' }, desk_id: { type: 'keyword' } },
  [INDEX.scans]: {
    '@timestamp': { type: 'date' }, scanned_at: { type: 'date' }, clock: { type: 'keyword' }, skew_ms: { type: 'long' },
    scan_id: { type: 'keyword' }, badge_id: { type: 'keyword' }, booth_id: { type: 'keyword' }, scanner_id: { type: 'keyword' }, consent: { type: 'boolean' },
  },
  [INDEX.emails]: { '@timestamp': { type: 'date' }, badge_id: { type: 'keyword' }, status: { type: 'keyword' }, detail: { type: 'keyword' }, domain: { type: 'keyword' } },
};

// Expo hall around the Salt Palace, booths ~40 m apart. Demo booths for the hackathon's sponsors.
const BOOTHS = [
  ['dash0', 'Dash0', 0, 0], ['sonar', 'Sonar', 0, 1], ['elastic', 'Elastic', 0, 2],
  ['radar', 'Radar', 1, 0], ['community', 'Community', 1, 1], ['demo', 'Demo', 1, 2],
].map(([booth_id, sponsor, row, col]) => ({ booth_id, sponsor, name: `${sponsor} booth`, location: { lat: 40.7631 + row * 0.00036, lon: -111.8962 + col * 0.00047 }, demo: true }));

function synthetic(n = 400, now = Date.now()) {
  // Deterministic pseudo-random so every reset gives the same people.
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const first = ['Mira', 'Jonas', 'Aisha', 'Mateo', 'Priya', 'Lena', 'Kenji', 'Sofia', 'Omar', 'Elif', 'Noah', 'Chloé', 'Arjun', 'Zoë', 'Lukas', 'Amara', 'Diego', 'Hana', 'Ravi', 'Ingrid', 'Tomás', 'Yuki', 'Fatima', 'Erik'];
  const last = ['Keller', 'Novak', 'Haddad', 'García', 'Sharma', 'Fischer', 'Tanaka', 'Rossi', 'Farouk', 'Yılmaz', 'Müller', 'Dubois', 'Iyer', 'Okafor', 'Lindqvist', 'Moreau', 'Silva', 'Kim', 'Brennan', 'Petrov'];
  const companies = [['Acme Cloud', 'acme.example'], ['Globex', 'globex.example'], ['Initech', 'initech.example'], ['Umbrella Systems', 'umbrella.example'], ['Hooli', 'hooli.example'], ['Stark Infra', 'stark.example'], ['Wayne Data', 'wayne.example'], ['Tyrell Labs', 'tyrell.example']];
  const out = [];
  for (let i = 0; i < n; i++) {
    const f = pick(first), l = pick(last), [company, domain] = pick(companies);
    const local = `${f}.${l}`.toLowerCase().normalize('NFD').replace(/[^\w.]/g, '');
    const r = rnd();
    // Most tickets arrive; Tyrell's mail server bounces some, a few land in spam, a few never confirm.
    const status = domain === 'tyrell.example' && r < 0.5 ? 'bounced' : r < 0.03 ? 'complained' : r < 0.06 ? 'sent' : r < 0.5 ? 'delivered' : 'opened';
    const detail = status === 'bounced' ? '550 5.7.1 rejected by recipient policy' : null;
    out.push({
      badge_id: `B${String(10001 + i)}`, order_id: `ORD-${String(50001 + Math.floor(i / 1.3))}`,
      name: `${f} ${l}`, emails: [`${local}@${domain}`], company,
      ticket_type: rnd() < 0.1 ? 'speaker' : rnd() < 0.15 ? 'sponsor' : 'attendee', needs_assistance: rnd() < 0.03,
      ticket_email: { status, at: new Date(now - (status === 'sent' ? 30 : 48) * 3600000).toISOString(), detail },
      synthetic: true,
    });
  }
  return out;
}

function fromCsv(file) {
  // Expected header: badge_id,order_id,name,email,company,ticket_type
  const [header, ...rows] = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const cols = header.split(',').map((c) => c.trim());
  return rows.map((line) => {
    const v = line.split(','); const r = Object.fromEntries(cols.map((c, i) => [c, (v[i] || '').trim()]));
    return { badge_id: r.badge_id.toUpperCase(), order_id: r.order_id.toUpperCase(), name: r.name, emails: [r.email.toLowerCase()], company: r.company, ticket_type: r.ticket_type || 'attendee', synthetic: false };
  });
}

async function bulk(index, docs, idField) {
  for (let i = 0; i < docs.length; i += 500) {
    const chunk = docs.slice(i, i + 500);
    const r = await es().bulk({ refresh: 'wait_for', operations: chunk.flatMap((d) => [{ index: { _index: index, _id: d[idField] } }, d]) });
    if (r.errors) throw new Error(`bulk ${index}: ${JSON.stringify(r.items.find((x) => x.index?.error).index.error).slice(0, 300)}`);
  }
  return docs.length;
}

async function main(argv = process.argv) {
  const reset = argv.includes('--reset');
  const csv = argv.includes('--csv') ? argv[argv.indexOf('--csv') + 1] : null;
  for (const [name, body] of Object.entries(INDICES)) {
    // A template too, so a write that races the seed (another pod writing first) still gets the
    // right mapping instead of dynamic text fields.
    await es().indices.putIndexTemplate({ name: `leadguard-${name}`, index_patterns: [name], priority: 400, template: { settings: body.settings, mappings: body.mappings } });
    const exists = await es().indices.exists({ index: name });
    if (exists && reset) await es().indices.delete({ index: name });
    // Two web pods may start together: "already exists" from the other one is fine.
    if (!exists || reset) await es().indices.create({ index: name, ...body }, { ignore: [400] });
  }
  // If leads was created before semantic search was configured (or by an early write), add the
  // semantic field in place instead of dropping the sponsors' leads.
  if (SEMANTIC) {
    const map = await es().indices.getMapping({ index: INDEX.leads });
    if (!map[INDEX.leads]?.mappings?.properties?.notes_semantic) {
      await es().indices.putMapping({ index: INDEX.leads, properties: { notes_semantic: { type: 'semantic_text', inference_id: SEMANTIC }, notes: { type: 'text', copy_to: 'notes_semantic' } } });
    }
  }
  for (const [name, properties] of Object.entries(STREAMS)) {
    await es().indices.putIndexTemplate({ name, index_patterns: [name], data_stream: {}, priority: 500, template: { mappings: { properties } } });
    if (reset) await es().indices.deleteDataStream({ name }, { ignore: [404] });
    await es().indices.createDataStream({ name }, { ignore: [400] }); // 400 = already exists
  }
  const booths = await bulk(INDEX.booths, BOOTHS, 'booth_id');
  const have = (await es().count({ index: INDEX.attendees })).count;
  const attendees = have && !reset && !csv ? 0 : await bulk(INDEX.attendees, csv ? fromCsv(csv) : synthetic(), 'badge_id');
  console.log(JSON.stringify({ level: 'info', msg: 'seed done', booths, attendees_loaded: attendees, attendees_existing: have, semantic: SEMANTIC || null, reset }));
}

if (require.main === module) {
  main().catch((err) => { console.error(JSON.stringify({ level: 'error', msg: err.message })); process.exit(1); });
}

// Retry until Elasticsearch is reachable (first boot: the model may still be deploying).
async function ensure({ attempts = 30, delayMs = 10000 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    try { await main([]); return true; } catch (err) {
      console.error(JSON.stringify({ level: 'warn', msg: `seed attempt ${i}: ${err.message}` }));
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return false;
}

module.exports = { synthetic, BOOTHS, main, ensure };
