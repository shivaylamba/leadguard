// Product telemetry helpers. The SDK itself is started by
// `--require @opentelemetry/auto-instrumentations-node/register` (see Dockerfile),
// configured from OTEL_* env vars. This file adds meaning (leadguard.* attributes and
// metrics) and pseudonymises badge ids: no badge id, name or email ever reaches a span,
// a metric or a log (Gitar rule: .gitar/review/leads-privacy.md).
const crypto = require('node:crypto');
const { trace, metrics, SpanStatusCode } = require('@opentelemetry/api');

const tracer = trace.getTracer('leadguard');
const meter = metrics.getMeter('leadguard');

const checkins = meter.createCounter('leadguard.checkins', { description: 'Badge check-ins at registration desks' });
const scans = meter.createCounter('leadguard.scans', { description: 'Lead scans received, by booth and outcome (accepted, duplicate, rejected)' });
const syncLag = meter.createHistogram('leadguard.scan.sync_lag', { unit: 's', description: 'Time from scan on the device to receipt by the server' });
const anomalies = meter.createCounter('leadguard.anomalies', { description: 'Integrity anomalies detected, by kind' });
const queueDepth = meter.createHistogram('leadguard.scanner.queue_depth', { description: 'Scans waiting on a scanner device, from heartbeats' });

const SALT = process.env.PSEUDONYM_SALT || 'leadguard-dev-salt';
function pseudonym(id) {
  if (!id) return 'anonymous';
  return crypto.createHash('sha256').update(SALT + String(id)).digest('hex').slice(0, 16);
}

async function inSpan(name, attributes, fn) {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      throw err;
    } finally {
      span.end();
    }
  });
}

function annotate(attrs) {
  const span = trace.getActiveSpan();
  if (span) span.setAttributes(attrs);
}

module.exports = { tracer, meter, checkins, scans, syncLag, anomalies, queueDepth, pseudonym, inSpan, annotate };
