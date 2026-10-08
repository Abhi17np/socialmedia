const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const pinoHttp = require('pino-http');
const rateLimit = require('express-rate-limit');
dotenv.config();

const { logger } = require('./lib/logger');
const { requireAuth } = require('./middleware/tenant');
const authRoutes = require('./routes/auth');
const socialRoutes = require('./routes/social');
const billingRoutes = require('./routes/billing');
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
app.use(API_PREFIX, socialRoutes.publicRouter);
app.use(API_PREFIX, billingRoutes.publicRouter);

app.use(API_PREFIX, requireAuth, apiLimiter);
app.use(API_PREFIX, authRoutes.protectedRouter);
app.use(API_PREFIX, socialRoutes.protectedRouter);
app.use(API_PREFIX, billingRoutes.protectedRouter);

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
