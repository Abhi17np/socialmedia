/**
 * Structured logging with a request id that threads through a request's
 * whole lifecycle — route handler, background job it enqueues, webhook
 * it triggers. A console.error string has no way to say "these five log
 * lines are the same request"; req.log.info({...}, "...") does, for free,
 * via pino-http's auto-generated (or inbound X-Request-Id) req.id.
 *
 * Usage: req.log.info({ tenantId: req.tenantId }, 'post scheduled') from
 * any route; logger.info(...) directly from code with no request (queue
 * workers, pollers).
 */
const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  // Pretty-print locally; ship plain JSON in production for log aggregation.
  transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty', options: { colorize: true } },
  // pino-http logs req.headers wholesale on every request (see server.js) —
  // without this, every tenant's live JWT bearer token (and any session
  // cookie) would sit in plaintext in every log line this app emits,
  // readable by anyone with log access, in production shipped straight to
  // whatever log aggregator reads this JSON. These paths cover both the
  // request-time field name pino-http serializes to (`req.headers...`)
  // and the plain `headers...` shape a direct `logger.info({headers})`
  // call elsewhere in this codebase would use.
  redact: {
    paths: [
      'req.headers.authorization', 'req.headers.cookie',
      'res.headers["set-cookie"]',
      'headers.authorization', 'headers.cookie'
    ],
    censor: '[redacted]'
  }
});

module.exports = { logger };
