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
  transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty', options: { colorize: true } }
});

module.exports = { logger };
