/**
 * One place that turns a bad request body into a 400 with a specific,
 * structured reason — instead of each route hand-rolling its own
 * `if (!x) return res.status(400).json(...)` checks (which is how the
 * original admin-panel code, and this app's first pass, both did it:
 * easy to get subtly inconsistent across routes, and easy to forget a
 * field entirely).
 */
function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: 'Invalid request body.',
        issues: result.error.issues.map(i => ({ path: i.path.join('.'), message: i.message }))
      });
    }
    req.body = result.data; // parsed + defaulted — routes trust req.body past this point
    next();
  };
}

module.exports = { validate };
