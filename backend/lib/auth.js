const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// No hardcoded fallback here on purpose — the old admin-panel code fell
// back to a literal string ('aegis-portal-super-secret-key-12345') when
// JWT_SECRET was unset, which meant every deployment that forgot to set
// it shared the same signing key. Refusing to boot without it is the
// correct failure mode for a multi-tenant app.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET must be set — refusing to start with no signing key or a shared default.');
}

const TOKEN_EXPIRY = '7d';

function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

// The token is the only place tenant_id and role travel between requests
// — every protected route trusts req.tenantId/req.userId/req.role
// strictly because they came off a verified signature, never off a
// request body or query param (see middleware/tenant.js).
function signToken({ userId, tenantId, role }) {
  return jwt.sign({ userId, tenantId, role }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET); // throws on invalid/expired — callers catch
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken };
