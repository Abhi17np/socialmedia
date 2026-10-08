const { verifyToken } = require('../lib/auth');

// Mounted on every protected route (server.js mounts it after the public
// OAuth-callback/webhook routes, same split admin-panel's routes/social.js
// used). Resolves tenant_id/userId/role from the JWT alone — never from
// a query param or request body, which is what let admin-panel's old
// /social/connect/:platform?brand=anything accept any caller-supplied
// brand string with no ownership check.
function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing Authorization: Bearer <token> header.' });

  try {
    const payload = verifyToken(token);
    // A platform-admin token (lib/auth.js's signPlatformToken) carries no
    // tenantId at all — reject it explicitly rather than letting it
    // through with req.tenantId undefined, which scoped() would then
    // reject anyway but with a confusing 500 instead of a clear 401.
    if (payload.scope === 'platform') return res.status(401).json({ error: 'This endpoint is for tenant users, not platform admins.' });
    req.tenantId = payload.tenantId;
    req.userId = payload.userId;
    req.role = payload.role;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

// For routes that gate on role (e.g. only owner/admin can disconnect an
// account or invite teammates) — pass the minimum role required.
const ROLE_RANK = { viewer: 0, member: 1, admin: 2, owner: 3 };

function requireRole(minRole) {
  return (req, res, next) => {
    if ((ROLE_RANK[req.role] ?? -1) < ROLE_RANK[minRole]) {
      return res.status(403).json({ error: `This action requires the "${minRole}" role or higher.` });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
