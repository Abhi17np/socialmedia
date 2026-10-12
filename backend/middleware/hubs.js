const { getSocialClient } = require('../social/db');

/**
 * The commercial gate for Sales Hub / Marketing Hub (strategy doc:
 * build both in full now, but keep them inaccessible until Social Hub
 * lands its first paying customer). Mounted on every Sales/Marketing
 * route after requireAuth, so req.tenantId is already trustworthy —
 * same reasoning as requireRole in middleware/tenant.js, just checking
 * tenants.hubs_enabled (migrations/011_hub_gating.sql) instead of role
 * rank. Only routes/platform.js's PATCH /tenants/:id/hubs can flip this;
 * nothing under requireAuth ever writes hubs_enabled.
 */
function requireHub(hubName) {
  return async (req, res, next) => {
    const client = getSocialClient();
    if (!client) return res.status(503).json({ error: 'Database not configured.' });

    try {
      const { data, error } = await client.from('tenants').select('hubs_enabled').eq('id', req.tenantId).maybeSingle();
      if (error) throw error;
      const enabled = !!(data && data.hubs_enabled && data.hubs_enabled[hubName]);
      if (!enabled) {
        return res.status(403).json({
          error: `${hubName === 'sales' ? 'Sales Hub' : 'Marketing Hub'} is not yet enabled for your workspace.`,
          code: 'HUB_NOT_ENABLED'
        });
      }
      next();
    } catch (err) {
      (req.log || console).error({ err }, `requireHub(${hubName}) check failed`);
      res.status(500).json({ error: 'Could not verify Hub access.' });
    }
  };
}

module.exports = { requireHub };
