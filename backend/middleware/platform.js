const { verifyToken } = require('../lib/auth');

// The internal ops console's own gate — completely separate from
// requireAuth (middleware/tenant.js). A tenant user's token has no
// `scope: 'platform'` claim, so it's rejected here just as a platform
// token is rejected by requireAuth, not merely "a role that happens not
// to be high enough."
function requirePlatformAdmin(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing Authorization: Bearer <token> header.' });

  try {
    const payload = verifyToken(token);
    if (payload.scope !== 'platform') return res.status(401).json({ error: 'This endpoint is for platform admins only.' });
    req.platformAdminId = payload.adminId;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

module.exports = { requirePlatformAdmin };
