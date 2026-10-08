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
app.use(API_PREFIX, tenantRouter);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  logger.info(`Social Hub API listening on port ${PORT} (routes under ${API_PREFIX})`);
  socialScheduler.start();
  socialPollers.start();
});

process.on('SIGTERM', async () => {
  await socialScheduler.stop();
  process.exit(0);
});
