/**
 * Agency Workspace (migration 043). A tenant acting as an "agency" can
 * see a READ-ONLY aggregate rollup across other tenants ("clients") it
 * manages, without logging into each one separately — but only once
 * BOTH sides have explicitly consented: the client proposes the link by
 * the agency's tenant slug, the agency separately approves it. Either
 * side can revoke at any time. The overview route below is the one
 * deliberate exception to "every query is scoped to req.tenantId" in
 * this whole app — it reads another tenant's aggregate counts on
 * purpose, but ONLY for a client_tenant_id that has an active
 * agency_links row naming req.tenantId as the agency side, checked
 * before any such read happens. No raw content (messages, post text)
 * is ever read here — only counts and sums.
 */
const express = require('express');
const { getSocialClient } = require('../social/db');
const { requireRole } = require('../middleware/tenant');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../lib/asyncHandler');
const { recordAudit } = require('../lib/audit');
const { proposeAgencyLinkSchema } = require('../lib/schemas');
const { canApprove, canRevoke, linkDirection } = require('../lib/agencyWorkspace');
const { latestFollowerCount } = require('../lib/socialMetrics');

const router = express.Router();

function requireSocialClient(res) {
  const client = getSocialClient();
  if (!client) {
    res.status(503).json({ error: 'Database not configured.' });
    return null;
  }
  return client;
}

/** Any agency_links row touching this tenant, either side — used by GET /agency/links and to check ownership before approve/revoke. */
async function findLinkForTenant(client, tenantId, linkId) {
  const { data, error } = await client.from('agency_links').select('*').eq('id', linkId)
    .or(`agency_tenant_id.eq.${tenantId},client_tenant_id.eq.${tenantId}`).maybeSingle();
  if (error) throw error;
  return data;
}

// admin+ — proposing to share your own tenant's data with another tenant is exactly the kind of
// action requireRole('admin') already gates for every other irreversible-ish settings change.
router.post('/agency/links', requireRole('admin'), validate(proposeAgencyLinkSchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { agencySlug } = req.body;

  const { data: agencyTenant, error: tenantErr } = await client.from('tenants').select('id, name, slug').eq('slug', agencySlug).maybeSingle();
  if (tenantErr) return res.status(500).json({ error: tenantErr.message });
  if (!agencyTenant) return res.status(404).json({ error: `No tenant found with slug "${agencySlug}".` });
  if (agencyTenant.id === req.tenantId) return res.status(400).json({ error: 'A tenant cannot be its own agency.' });

  const { data: existing, error: existingErr } = await client.from('agency_links').select('*')
    .eq('agency_tenant_id', agencyTenant.id).eq('client_tenant_id', req.tenantId).maybeSingle();
  if (existingErr) return res.status(500).json({ error: existingErr.message });

  if (existing && existing.status !== 'revoked') {
    return res.status(409).json({ error: `A link with this agency is already ${existing.status}.` });
  }

  // Re-proposing after a revoke updates the same row (clean history for this pair) rather than
  // accumulating duplicate rows — the unique(agency_tenant_id, client_tenant_id) constraint would
  // reject a second insert anyway, so this is the only way back to 'pending' after a revoke.
  const payload = {
    agency_tenant_id: agencyTenant.id, client_tenant_id: req.tenantId, status: 'pending',
    proposed_by: req.userId, approved_by: null, approved_at: null, revoked_by: null, revoked_at: null
  };
  const { data, error } = existing
    ? await client.from('agency_links').update(payload).eq('id', existing.id).select().single()
    : await client.from('agency_links').insert(payload).select().single();
  if (error) return res.status(500).json({ error: error.message });

  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'agency.link.proposed', targetType: 'agency_link', targetId: data.id, metadata: { agencyTenantSlug: agencySlug } });
  res.status(201).json({ link: data });
}));

router.get('/agency/links', asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data, error } = await client.from('agency_links').select('*')
    .or(`agency_tenant_id.eq.${req.tenantId},client_tenant_id.eq.${req.tenantId}`).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  const otherTenantIds = [...new Set((data || []).map((l) => (l.agency_tenant_id === req.tenantId ? l.client_tenant_id : l.agency_tenant_id)))];
  const { data: otherTenants } = otherTenantIds.length
    ? await client.from('tenants').select('id, name, slug').in('id', otherTenantIds)
    : { data: [] };
  const tenantById = new Map((otherTenants || []).map((t) => [t.id, t]));

  const links = (data || []).map((l) => ({
    ...l,
    direction: linkDirection(l, req.tenantId),
    otherTenant: tenantById.get(l.agency_tenant_id === req.tenantId ? l.client_tenant_id : l.agency_tenant_id) || null
  }));
  res.json({ links });
}));

router.patch('/agency/links/:id/approve', requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const link = await findLinkForTenant(client, req.tenantId, req.params.id);
  if (!link) return res.status(404).json({ error: 'Agency link not found.' });
  if (!canApprove(link, req.tenantId)) {
    return res.status(403).json({ error: 'Only the agency side can approve a pending link, and only while it is still pending.' });
  }

  const { data, error } = await client.from('agency_links').update({ status: 'active', approved_by: req.userId, approved_at: new Date().toISOString() }).eq('id', link.id).select().single();
  if (error) return res.status(500).json({ error: error.message });

  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'agency.link.approved', targetType: 'agency_link', targetId: link.id, metadata: { clientTenantId: link.client_tenant_id } });
  res.json({ link: data });
}));

router.patch('/agency/links/:id/revoke', requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const link = await findLinkForTenant(client, req.tenantId, req.params.id);
  if (!link) return res.status(404).json({ error: 'Agency link not found.' });
  if (!canRevoke(link, req.tenantId)) return res.status(409).json({ error: 'This link is already revoked.' });

  const { data, error } = await client.from('agency_links').update({ status: 'revoked', revoked_by: req.userId, revoked_at: new Date().toISOString() }).eq('id', link.id).select().single();
  if (error) return res.status(500).json({ error: error.message });

  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'agency.link.revoked', targetType: 'agency_link', targetId: link.id });
  res.json({ link: data });
}));

/** Real, read-only aggregate counts for one client tenant — never raw content. */
async function gatherClientOverview(client, clientTenantId) {
  const { data: accounts } = await client.from('social_accounts').select('id, platform').eq('tenant_id', clientTenantId).eq('status', 'active');
  const followerCounts = await Promise.all((accounts || []).map((a) => latestFollowerCount(client, a.id, a.platform)));
  const totalFollowers = followerCounts.reduce((sum, f) => sum + f, 0);

  const [{ count: openMentions }, { count: openMessages }, { count: pendingApprovalPosts }, { count: openCrisisAlerts }] = await Promise.all([
    client.from('mentions').select('id', { count: 'exact', head: true }).eq('tenant_id', clientTenantId).eq('interaction_status', 'open'),
    client.from('inbox_messages').select('id', { count: 'exact', head: true }).eq('tenant_id', clientTenantId).eq('interaction_status', 'open'),
    client.from('scheduled_posts').select('id', { count: 'exact', head: true }).eq('tenant_id', clientTenantId).eq('status', 'pending_review'),
    client.from('crisis_alerts').select('id', { count: 'exact', head: true }).eq('tenant_id', clientTenantId).eq('status', 'open')
  ]);

  return {
    connectedAccounts: (accounts || []).length,
    totalFollowers,
    openInteractions: (openMentions || 0) + (openMessages || 0),
    pendingApprovalPosts: pendingApprovalPosts || 0,
    openCrisisAlerts: openCrisisAlerts || 0
  };
}

router.get('/agency/overview', asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;

  const { data: activeLinks, error } = await client.from('agency_links').select('*').eq('agency_tenant_id', req.tenantId).eq('status', 'active');
  if (error) return res.status(500).json({ error: error.message });

  const clientTenantIds = (activeLinks || []).map((l) => l.client_tenant_id);
  const { data: clientTenants } = clientTenantIds.length
    ? await client.from('tenants').select('id, name, slug').in('id', clientTenantIds)
    : { data: [] };
  const tenantById = new Map((clientTenants || []).map((t) => [t.id, t]));

  const clients = await Promise.all((activeLinks || []).map(async (link) => ({
    linkId: link.id,
    tenant: tenantById.get(link.client_tenant_id) || null,
    overview: await gatherClientOverview(client, link.client_tenant_id)
  })));

  res.json({ clients });
}));

module.exports = router;
