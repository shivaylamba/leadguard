// Elasticsearch is the only data store: attendees, check-ins, scans, leads, booths, scanners, anomalies.
// Local: the in-cluster single node (deploy/local). Hackathon: Elastic Serverless via Secret es-credentials.
const { Client } = require('@elastic/elasticsearch');

const INDEX = {
  attendees: 'attendees',   // registry, imported from the registration tool (CSV)
  checkins: 'checkins',     // data stream: every check-in event
  checkedIn: 'checked_in',  // lookup-mode index: badge_id → first_checkin_at (for ES|QL LOOKUP JOIN)
  booths: 'booths',
  scans: 'scans',           // data stream: every scan as received, _id = scan_id (idempotent)
  leads: 'leads',           // one per booth+badge, what the sponsor exports
  scanners: 'scanners',     // last heartbeat per scanner device
  anomalies: 'anomalies',   // one per anomaly, deterministic id
  emails: 'ticket_emails',  // data stream: ticket email events from the provider webhook
  signals: 'signals',       // kiosk threat signals (kiosk/detect.py)
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
