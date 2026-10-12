const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const dotenv = require('dotenv');
const pinoHttp = require('pino-http');
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
const whatsappRoutes = require('./routes/whatsapp');
const salesRoutes = require('./routes/sales');
const marketingRoutes = require('./routes/marketing');
const socialScheduler = require('./social/scheduler');
const socialPollers = require('./social/pollers');
const broadcastQueue = require('./social/broadcastQueue');

// Versioned from day one — nothing in production depends on an
// unversioned path yet, which is exactly the window in which this is
// free to do and after which it's a breaking change for every caller.
// Shared with the OAuth adapters via lib/apiPrefix.js so their
// redirect_uri can never drift from where these routes actually mount.
const { API_PREFIX } = require('./lib/apiPrefix');

// Comma-separated so a staging + prod frontend (or the platform console,
// if it's ever split to its own domain) can both be allowed without code
// changes. Previously this was a bare cors() — every origin, no
// allowlist at all — so any website could call this API from a
// logged-in tenant's browser using their own cookies/localStorage token.
const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:3000')
  .split(',').map(o => o.trim()).filter(Boolean);

const app = express();
// disable: this API serves JSON to a separate frontend origin, not HTML
// it renders itself, so CSP's main job (restricting what a same-origin
// page may load) doesn't apply here, and a default-deny CSP would just
// break CORS preflight responses for no benefit.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: allowedOrigins }));
app.use(pinoHttp({ logger })); // attaches req.log + req.id to every request, public or protected

// `verify` stashes the raw request body bytes on req.rawBody — needed by
// routes/social.js's WhatsApp webhook and routes/billing.js's Razorpay
// webhook to check their respective HMAC signature headers, which are
// computed over the exact raw bytes sent, not a re-serialization of the
// parsed JSON.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// authLimiter is intentionally NOT mounted here as a blanket middleware
// — it's applied per-route inside routes/auth.js and routes/platform.js
// instead. See lib/rateLimiters.js's header comment for why: a blanket
// `app.use(API_PREFIX, authLimiter, router)` ran authLimiter for every
// request matching the bare `/api/v1` prefix, not just the auth routes,
// because Express falls through to the next app.use() layer whenever
// the mounted router has no matching route of its own.
const { apiLimiter, aiLimiter, platformLimiter } = require('./lib/rateLimiters');

app.get(`${API_PREFIX}/health`, (req, res) => res.json({ status: 'ok' }));

// Unauthenticated by necessity: OAuth providers and payment/messaging
// webhooks call these directly and can't carry a Bearer header. Each
// authenticates itself its own way (signed state, HMAC signature) — see
// their own files for why. Mounted before requireAuth below, which
// otherwise applies to every route registered after it under this
// prefix, regardless of path — health and these public routes have to
// come first.
app.use(API_PREFIX, authRoutes.router);
app.use(API_PREFIX, platformRoutes.publicRouter);
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
// handled it, since Express can't know that in advance.) platformLimiter
// is safe as a blanket mount here specifically because nothing else is
// ever mounted at this exact sub-path — unlike authLimiter above.
app.use(`${API_PREFIX}/platform`, requirePlatformAdmin, platformLimiter, platformRoutes.protectedRouter);

const tenantRouter = express.Router();
tenantRouter.use(requireAuth, apiLimiter);
tenantRouter.use(authRoutes.protectedRouter);
tenantRouter.use(socialRoutes.protectedRouter);
tenantRouter.use(billingRoutes.protectedRouter);
tenantRouter.use(teamRoutes);
tenantRouter.use(whatsappRoutes);
tenantRouter.use(salesRoutes);
tenantRouter.use(marketingRoutes);
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

// Everything below only runs when this file is executed directly (`node
// server.js` / `node --watch server.js`), not when it's require()'d —
// test/*.test.js files require() this module to get `app` for supertest
// without binding a real port or starting the scheduler/pollers/BullMQ
// worker as a side effect of running the test suite.
if (require.main === module) {
  const PORT = process.env.PORT || 5001;
  const server = app.listen(PORT, () => {
    logger.info(`Social Hub API listening on port ${PORT} (routes under ${API_PREFIX})`);
    socialScheduler.start();
    socialPollers.start();
    broadcastQueue.start();
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
  const shutdown = async (signal) => {
    if (shuttingDown) return; // a second Ctrl-C shouldn't re-enter this
    shuttingDown = true;
    logger.info(`${signal} received — shutting down.`);

    // A hung Redis close or a browser keep-alive socket must not be able
    // to block the restart indefinitely.
    const forceExit = setTimeout(() => {
      logger.warn('Graceful shutdown timed out after 10s — exiting anyway.');
      process.exit(1);
    }, 10_000).unref();

    try {
      socialPollers.stop();           // the mentions + analytics setIntervals
      await socialScheduler.stop();   // sweep interval, then BullMQ worker/queue and Redis
      await broadcastQueue.stop();    // the WhatsApp broadcast worker/queue and its own Redis connection
      const closed = new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
      // server.close() only stops new connections; without this it waits
      // on idle keep-alives the dashboard leaves open and never resolves.
      server.closeAllConnections?.();
      await closed;
      clearTimeout(forceExit);
      logger.info('Shutdown complete — port released.');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Shutdown failed');
      process.exit(1);
    }
  };

  // SIGINT as well: Ctrl-C used to leave the BullMQ worker and both
  // pollers running until the shell reaped them.
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = app;
