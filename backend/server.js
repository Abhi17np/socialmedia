const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const pinoHttp = require('pino-http');
const rateLimit = require('express-rate-limit');
dotenv.config();

const { logger } = require('./lib/logger');
const { requireAuth } = require('./middleware/tenant');
const { requirePlatformAdmin } = require('./middleware/platform');
const authRoutes = require('./routes/auth');
const socialRoutes = require('./routes/social');
const billingRoutes = require('./routes/billing');
const teamRoutes = require('./routes/team');
const platformRoutes = require('./routes/platform');
const aiRoutes = require('./routes/ai');
const socialScheduler = require('./social/scheduler');
const socialPollers = require('./social/pollers');

// Versioned from day one — nothing in production depends on an
// unversioned path yet, which is exactly the window in which this is
// free to do and after which it's a breaking change for every caller.
const API_PREFIX = '/api/v1';

const app = express();
app.use(cors());
app.use(pinoHttp({ logger })); // attaches req.log + req.id to every request, public or protected

// `verify` stashes the raw request body bytes on req.rawBody — needed by
// routes/social.js's WhatsApp webhook and routes/billing.js's Razorpay
// webhook to check their respective HMAC signature headers, which are
// computed over the exact raw bytes sent, not a re-serialization of the
// parsed JSON.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// Auth endpoints get their own, much stricter limit — the thing being
// protected here is credential brute-forcing, not general API abuse.
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
// Everything else an authenticated tenant calls. Deliberately NOT applied
// to the public webhook/OAuth-callback routes below — Meta and Razorpay
// retry their own webhooks on failure, and rate-limiting a payment
// provider's retries would make their outages worse, not better.
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 600, standardHeaders: true, legacyHeaders: false });
// AI Assist calls real, metered Anthropic spend per request — the
// monthly plan cap (lib/plans.js) catches sustained overuse, but a burst
// within a single month shouldn't be free to run up; much tighter than
// apiLimiter on purpose.
const aiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

app.get(`${API_PREFIX}/health`, (req, res) => res.json({ status: 'ok' }));

// Unauthenticated by necessity: OAuth providers and payment/messaging
// webhooks call these directly and can't carry a Bearer header. Each
// authenticates itself its own way (signed state, HMAC signature) — see
// their own files for why. Mounted before requireAuth below, which
// otherwise applies to every route registered after it under this
// prefix, regardless of path — health and these public routes have to
// come first.
app.use(API_PREFIX, authLimiter, authRoutes.router);
app.use(API_PREFIX, authLimiter, platformRoutes.publicRouter);
app.use(API_PREFIX, socialRoutes.publicRouter);
app.use(API_PREFIX, billingRoutes.publicRouter);

// requirePlatformAdmin is mounted at the more specific `${API_PREFIX}/platform`
// path, and registered BEFORE the broader tenant mount below — Express
// tries app.use() blocks in registration order and only enters one whose
// path prefix actually matches, so a request to /api/v1/social/... never
// touches this block at all, and one to /api/v1/platform/... is fully
// handled here and never reaches requireAuth. (The earlier attempt at
// this — two routers both mounted at the bare API_PREFIX — was broken:
// a blanket `.use(requireAuth)` on one runs for every request matching
// that prefix regardless of which router's own routes would have
// handled it, since Express can't know that in advance.)
app.use(
  `${API_PREFIX}/platform`,
  requirePlatformAdmin,
  rateLimit({ windowMs: 15 * 60 * 1000, limit: 600, standardHeaders: true, legacyHeaders: false }),
  platformRoutes.protectedRouter
);

const tenantRouter = express.Router();
tenantRouter.use(requireAuth, apiLimiter);
tenantRouter.use(authRoutes.protectedRouter);
tenantRouter.use(socialRoutes.protectedRouter);
tenantRouter.use(billingRoutes.protectedRouter);
tenantRouter.use(teamRoutes);
// Scoped to '/ai' specifically (not a blanket tenantRouter.use()) so
// aiLimiter's much tighter cap only governs AI Assist calls, not every
// route registered after it — the same mounting-order lesson server.js
// already learned once with requireAuth/requirePlatformAdmin above.
tenantRouter.use('/ai', aiLimiter, aiRoutes);
app.use(API_PREFIX, tenantRouter);

// Last middleware in the chain: anything a route throws synchronously
// lands here as a 500 instead of escaping to the process. lib/query.js's
// scoped() used to throw a TypeError on every tenant route, and with no
// handler mounted that single bad call killed the server outright —
// `node --watch` then sat at "Waiting for file changes" and the whole
// API stayed down until someone noticed.
// eslint-disable-next-line no-unused-vars -- Express needs the 4-arg shape
app.use((err, req, res, next) => {
  (req.log || logger).error({ err }, 'Unhandled error in request');
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

// A rejected promise in a background sweep or a BullMQ job has no request
// to attach to, and Node's default for an unhandled rejection is to
// terminate. Log it and keep serving; the pollers already tolerate a
// failed sweep.
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled promise rejection — continuing.');
});

const PORT = process.env.PORT || 5001;
const server = app.listen(PORT, () => {
  logger.info(`Social Hub API listening on port ${PORT} (routes under ${API_PREFIX})`);
  socialScheduler.start();
  socialPollers.start();
});

// Tear down in the reverse order we started, and don't exit until the
// listener has actually released the port. The previous version called
// process.exit(0) straight after scheduler.stop() and never touched
// `server` or the pollers — so the port stayed bound into the next tick.
// That is precisely what `node --watch` trips over: it SIGTERMs this
// process, immediately re-spawns, and the replacement dies with
// EADDRINUSE, leaving the watcher parked at "Waiting for file changes
// before restarting" with nothing serving the API. Every edit to a
// backend file silently took the whole backend down.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return; // a second Ctrl-C shouldn't re-enter this
  shuttingDown = true;
  logger.info(`${signal} received — shutting down.`);

  // A hung Redis close or a browser keep-alive socket must not be able to
  // block the restart indefinitely.
  const forceExit = setTimeout(() => {
    logger.warn('Graceful shutdown timed out after 10s — exiting anyway.');
    process.exit(1);
  }, 10_000).unref();

  try {
    socialPollers.stop();           // the mentions + analytics setIntervals
    await socialScheduler.stop();   // sweep interval, then BullMQ worker/queue and Redis
    const closed = new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
    // server.close() only stops new connections; without this it waits on
    // idle keep-alives the dashboard leaves open and never resolves.
    server.closeAllConnections?.();
    await closed;
    clearTimeout(forceExit);
    logger.info('Shutdown complete — port released.');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Shutdown failed');
    process.exit(1);
  }
}

// SIGINT as well: Ctrl-C used to leave the BullMQ worker and both pollers
// running until the shell reaped them.
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
