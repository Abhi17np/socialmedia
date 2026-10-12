/**
 * Express 4 does not forward a rejected promise from an async route
 * handler to error-handling middleware — only Express 5 does that. An
 * unhandled rejection inside `async (req, res) => {...}` here was only
 * ever caught by server.js's process-level `unhandledRejection` logger,
 * which logs and continues but never sends a response: the request just
 * hung until the client's own timeout. A handful of routes had no
 * try/catch at all and hit exactly this. Wrapping every async handler
 * here makes "forgot the try/catch" structurally impossible instead of
 * something to remember per route.
 */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { asyncHandler };
