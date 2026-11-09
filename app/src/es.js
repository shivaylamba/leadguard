// Elasticsearch is the only data store: sessions, rooms, check-ins, prefs, queries, signals.
// Local: the in-cluster single node (deploy/local). Hackathon: Elastic Serverless via Secret es-credentials.
const { Client } = require('@elastic/elasticsearch');

const INDEX = {
  sessions: 'sessions',
  rooms: 'rooms',
  checkins: 'checkins', // data stream (index template in mappings/checkins.json)
  prefs: 'prefs',
  queries: 'queries',
  signals: 'signals',
};

let client;
function es() {
  if (!client) {
    const node = process.env.ES_URL || 'http://localhost:9200';
    const apiKey = process.env.ES_API_KEY;
    // Ingest can wait minutes on the first semantic_text write (the model deploys); requests stay short.
    const requestTimeout = Number(process.env.ES_REQUEST_TIMEOUT_MS || 5000);
    client = new Client({ node, ...(apiKey ? { auth: { apiKey } } : {}), requestTimeout });
  }
  return client;
}

// semantic_text needs an inference endpoint. Unset → keyword-only search, and the
// app says so in /api/config instead of failing.
const SEMANTIC = process.env.SEMANTIC_INFERENCE_ID || '';

async function ready() {
  try {
    await es().ping();
    return true;
  } catch {
    return false;
  }
}

module.exports = { es, INDEX, SEMANTIC, ready };
