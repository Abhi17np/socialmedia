/**
 * Shared rate-limiter instances and the JSON error shape they share
 * (express-rate-limit's own default body is plain text, not JSON — see
 * the `message` option below).
 *
 * Previously authLimiter was passed to server.js's blanket
 * `app.use(API_PREFIX, authLimiter, authRoutes.router)` (and again for
 * platformRoutes.publicRouter) — a path-prefix mount, not a route match.
 * Express still runs that middleware for ANY request matching the
 * `/api/v1` prefix that reaches that point in the stack, then falls
 * through to the next app.use() layer when the mounted router has no
 * matching route — which every non-auth route does. So authLimiter's
 * strict 20-per-15-min cap was silently consumed by every request to
 * every route, capping all API traffic at ~20 requests/15min instead of
 * apiLimiter's intended 600 — exposed by an integration test exhausting
 * it and then seeing unrelated routes 429. Mounting a limiter directly
 * on each specific route definition (not via a shared router's blanket
 * prefix) is the fix that can't have this failure mode: it only ever
 * runs when that exact route actually matches.
 */
const rateLimit = require('express-rate-limit');

const rateLimited = { error: 'Too many requests — please slow down and try again in a few minutes.' };

// Auth endpoints get their own, much stricter limit — the thing being
// protected here is credential brute-forcing, not general API abuse.
// Applied per-route (routes/auth.js, routes/platform.js), never as a
// blanket router-level mount — see the file header above for why.
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, message: rateLimited });

// Everything an authenticated tenant calls — mounted once on
// tenantRouter in server.js, which is fine: it's the single, final
// app.use() layer, so it only ever runs once per request, uniformly,
// which is the actually-intended behavior for a general API cap.
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 600, standardHeaders: true, legacyHeaders: false, message: rateLimited });

// AI Assist calls real, metered Anthropic spend per request — the
// monthly plan cap (lib/plans.js) catches sustained overuse, but a burst
// within a single month shouldn't be free to run up; much tighter than
// apiLimiter on purpose. Mounted on tenantRouter's '/ai' sub-path only.
const aiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: rateLimited });

// Platform-admin console traffic — mounted on the specific
// `${API_PREFIX}/platform` sub-path in server.js, which is narrow enough
// not to have the blanket-mount problem above.
const platformLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 600, standardHeaders: true, legacyHeaders: false, message: rateLimited });

module.exports = { rateLimited, authLimiter, apiLimiter, aiLimiter, platformLimiter };
