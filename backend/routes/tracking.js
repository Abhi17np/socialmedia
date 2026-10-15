/**
 * Website tracking snippet (Phase 10, closing the F3 gap Phase 0's audit
 * flagged as deferrable). Mounted PUBLIC — this is a pixel/beacon
 * endpoint called from the TENANT'S OWN external website, a different
 * origin than this app's frontend, so it needs open CORS (see
 * server.js's dedicated `app.use('${API_PREFIX}/track', cors())`,
 * registered before the app-wide origin allowlist so this one path is
 * exempt from it). tenantId is public by design here, exactly like a
 * Google Analytics property ID or a Meta Pixel ID embedded in a
 * <script> tag on a public page — it identifies which tenant's counter
 * to increment, nothing more; there is no read access through this
 * route and no cookie/auth is ever sent or trusted.
 *
 * Identity resolution is deliberately simple: the visitor is anonymous
 * (a client-generated UUID in localStorage) until they submit a lead
 * form on the SAME browser, at which point routes/leadForms.js links
 * their site_visitors row to the real contact it just created/resolved
 * — no cross-device stitching, no third-party cookie tricks.
 */
const express = require('express');
const { getSocialClient } = require('../social/db');
const { asyncHandler } = require('../lib/asyncHandler');
const { requireHub } = require('../middleware/hubs');
const { API_PREFIX } = require('../lib/apiPrefix');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const publicRouter = express.Router();
const router = express.Router();

function requireSocialClient(res) {
  const client = getSocialClient();
  if (!client) {
    res.status(503).json({ error: 'Database not configured.' });
    return null;
  }
  return client;
}

publicRouter.post('/track/pageview', asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;

  const { tenantId, visitorId, url, referrer } = req.body || {};
  if (!UUID_RE.test(tenantId) || !UUID_RE.test(visitorId) || typeof url !== 'string' || !url.trim()) {
    return res.status(400).json({ error: 'tenantId, visitorId and url are required.' });
  }

  const { data: tenant } = await client.from('tenants').select('id').eq('id', tenantId).maybeSingle();
  if (!tenant) return res.status(404).json({ error: 'Unknown tenant.' });

  const upsertResult = await client.from('site_visitors').upsert(
    { id: visitorId, tenant_id: tenantId, last_seen_at: new Date().toISOString() },
    { onConflict: 'id', ignoreDuplicates: false }
  );
  if (upsertResult.error) throw upsertResult.error;
  const insertResult = await client.from('site_visits').insert({
    tenant_id: tenantId, visitor_id: visitorId, url: String(url).slice(0, 2000), referrer: referrer ? String(referrer).slice(0, 2000) : null
  });
  if (insertResult.error) throw insertResult.error;

  res.status(204).end();
}));

/** The <script> a tenant pastes into their site's <head>. Kept server-rendered (not a static frontend asset) so the API_BASE it posts to always matches this deployment, including self-hosted installs with a different backend URL. */
function snippetFor(tenantId, apiBase) {
  return `<script>(function(){var t="${tenantId}";var a="${apiBase}/track/pageview";var k="_mkt_visitor_id";var v=localStorage.getItem(k);if(!v){v=crypto.randomUUID();localStorage.setItem(k,v);}navigator.sendBeacon?navigator.sendBeacon(a,new Blob([JSON.stringify({tenantId:t,visitorId:v,url:location.href,referrer:document.referrer})],{type:"application/json"})):fetch(a,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({tenantId:t,visitorId:v,url:location.href,referrer:document.referrer}),keepalive:true});})();</script>`;
}

router.get('/marketing/tracking/snippet', requireHub('marketing'), (req, res) => {
  const apiBase = `${req.protocol}://${req.get('host')}${API_PREFIX}`;
  res.json({ snippet: snippetFor(req.tenantId, apiBase) });
});

router.get('/marketing/tracking/summary', requireHub('marketing'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const [visitors, visits, identified] = await Promise.all([
    client.from('site_visitors').select('id', { count: 'exact', head: true }).eq('tenant_id', req.tenantId),
    client.from('site_visits').select('id', { count: 'exact', head: true }).eq('tenant_id', req.tenantId).gte('created_at', since),
    client.from('site_visitors').select('id', { count: 'exact', head: true }).eq('tenant_id', req.tenantId).not('contact_id', 'is', null)
  ]);
  res.json({ totalVisitors: visitors.count || 0, pageviewsLast30d: visits.count || 0, identifiedVisitors: identified.count || 0 });
}));

module.exports = { router, publicRouter, snippetFor };
