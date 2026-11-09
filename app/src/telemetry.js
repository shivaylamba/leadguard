// Product telemetry helpers. The SDK itself is started by
// `--require @opentelemetry/auto-instrumentations-node/register` (see Dockerfile),
// configured entirely from OTEL_* env vars. This file only adds meaning:
// conference.* attributes, product metrics, and hashing so no raw device id
// ever reaches a span, a metric or a log (Gitar rule: .gitar/review/otel.md).
const crypto = require('node:crypto');
const { trace, metrics, SpanStatusCode } = require('@opentelemetry/api');

const tracer = trace.getTracer('overflow');
const meter = metrics.getMeter('overflow');

const checkins = meter.createCounter('conference.checkins', {
  description: 'Room check-ins and check-outs',
});
const searches = meter.createCounter('conference.searches', {
  description: 'Talk searches by mode and whether they returned anything',
});
const redirects = meter.createCounter('conference.overflow.redirects', {
  description: 'Recommendations served because a room was full',
});

// One-way pseudonym for a device id. Salted so ids from other systems can't be joined.
const SALT = process.env.PSEUDONYM_SALT || 'overflow-dev-salt';
function pseudonym(deviceId) {
  if (!deviceId) return 'anonymous';
  return crypto.createHash('sha256').update(SALT + String(deviceId)).digest('hex').slice(0, 16);
}

// Run fn inside an active span; record errors; always end the span.
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

// Mark the auto-instrumented server span of this request with conference attributes.
function annotate(attrs) {
  const span = trace.getActiveSpan();
  if (span) span.setAttributes(attrs);
}

module.exports = { tracer, meter, checkins, searches, redirects, pseudonym, inSpan, annotate };
