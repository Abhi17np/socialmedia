/**
 * Sales Hub: companies, lead-tracked contacts, deal pipelines and sales
 * activities. Extends the existing contacts spine (003_contacts.sql,
 * extended in 013_sales_crm.sql) rather than introducing a parallel
 * "lead" entity — a contact that first appeared via a WhatsApp inbound
 * message and one entered by hand here are the exact same row.
 *
 * Gated behind tenants.hubs_enabled->>'sales' (requireHub('sales')),
 * mounted after requireAuth same as every other tenant route — see
 * server.js.
 */

const express = require('express');
const { getSocialClient } = require('../social/db');
const { scoped } = require('../lib/query');
const { requireRole } = require('../middleware/tenant');
const { requireHub } = require('../middleware/hubs');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../lib/asyncHandler');
const { recordAudit } = require('../lib/audit');
const { fireTrigger } = require('../lib/automation');
const { companySchema, contactSchema, updateContactSchema, dealSchema, moveDealStageSchema, salesActivitySchema } = require('../lib/schemas');

const router = express.Router();
router.use(requireHub('sales'));

function requireSocialClient(res) {
  const client = getSocialClient();
  if (!client) {
    res.status(503).json({ error: 'Database not configured (SUPABASE_URL_SOCIAL / SUPABASE_KEY_SOCIAL in .env).' });
    return null;
  }
  return client;
}

function pageParams(req) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
  return { page, pageSize, from: (page - 1) * pageSize, to: (page - 1) * pageSize + pageSize - 1 };
}

// -------------------------------------------------------------
// Companies
// -------------------------------------------------------------

router.get('/sales/companies', asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { page, pageSize, from, to } = pageParams(req);
  let query = scoped(client, req.tenantId, 'companies').select('*', { count: 'exact' }).order('created_at', { ascending: false }).range(from, to);
  if (req.query.search) query = query.ilike('name', `%${req.query.search}%`);
  const { data, error, count } = await query;
  if (error) throw error;
  res.json({ companies: data, page, pageSize, total: count });
}));

router.post('/sales/companies', requireRole('member'), validate(companySchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data, error } = await client.from('companies').insert({
    tenant_id: req.tenantId, name: req.body.name, domain: req.body.domain || null, industry: req.body.industry || null,
    size: req.body.size || null, phone: req.body.phone || null, address: req.body.address || null, notes: req.body.notes || null,
    owner_id: req.body.ownerId || null
  }).select('*').single();
  if (error) throw error;
  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'sales.company_created', targetType: 'company', targetId: data.id, metadata: { name: data.name } });
  res.status(201).json({ company: data });
}));

router.get('/sales/companies/:id', asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data: company, error } = await scoped(client, req.tenantId, 'companies').select('*').eq('id', req.params.id).maybeSingle();
  if (error) throw error;
  if (!company) return res.status(404).json({ error: 'Company not found.' });

  const [{ data: contacts }, { data: deals }] = await Promise.all([
    scoped(client, req.tenantId, 'contacts').select('id, display_name, phone, email, job_title, lead_status').eq('company_id', company.id),
    scoped(client, req.tenantId, 'deals').select('id, name, amount, status, stage_id').eq('company_id', company.id)
  ]);
  res.json({ company, contacts: contacts || [], deals: deals || [] });
}));

router.patch('/sales/companies/:id', requireRole('member'), validate(companySchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data, error } = await scoped(client, req.tenantId, 'companies').update({
    name: req.body.name, domain: req.body.domain || null, industry: req.body.industry || null, size: req.body.size || null,
    phone: req.body.phone || null, address: req.body.address || null, notes: req.body.notes || null, owner_id: req.body.ownerId || null,
    updated_at: new Date().toISOString()
  }).eq('id', req.params.id).select('*').single();
  if (error || !data) return res.status(404).json({ error: 'Company not found.' });
  res.json({ company: data });
}));

router.delete('/sales/companies/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { error } = await scoped(client, req.tenantId, 'companies').delete().eq('id', req.params.id);
  if (error) throw error;
  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'sales.company_deleted', targetType: 'company', targetId: req.params.id });
  res.json({ success: true });
}));

// -------------------------------------------------------------
// Contacts / leads (the shared spine, with CRM fields)
// -------------------------------------------------------------

router.get('/sales/contacts', asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { page, pageSize, from, to } = pageParams(req);
  let query = scoped(client, req.tenantId, 'contacts').select('*', { count: 'exact' }).order('created_at', { ascending: false }).range(from, to);
  if (req.query.leadStatus) query = query.eq('lead_status', req.query.leadStatus);
  if (req.query.companyId) query = query.eq('company_id', req.query.companyId);
  if (req.query.search) query = query.or(`display_name.ilike.%${req.query.search}%,phone.ilike.%${req.query.search}%,email.ilike.%${req.query.search}%`);
  const { data, error, count } = await query;
  if (error) throw error;
  res.json({ contacts: data, page, pageSize, total: count });
}));

router.post('/sales/contacts', requireRole('member'), validate(contactSchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { displayName, phone, email, companyId, jobTitle, leadStatus, ownerId, tags } = req.body;

  const { data, error } = await client.from('contacts').insert({
    tenant_id: req.tenantId, display_name: displayName, phone: phone || null, email: email || null,
    company_id: companyId || null, job_title: jobTitle || null, lead_status: leadStatus || 'new',
    lead_source: 'manual', owner_id: ownerId || null, tags: tags || []
  }).select('*').single();
  if (error) throw error;

  await fireTrigger(client, req.tenantId, 'contact_created', { refType: 'contact', refId: data.id, contactId: data.id });
  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'sales.contact_created', targetType: 'contact', targetId: data.id, metadata: { displayName } });
  res.status(201).json({ contact: data });
}));

router.get('/sales/contacts/:id', asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data: contact, error } = await scoped(client, req.tenantId, 'contacts').select('*').eq('id', req.params.id).maybeSingle();
  if (error) throw error;
  if (!contact) return res.status(404).json({ error: 'Contact not found.' });

  const [{ data: deals }, { data: activities }] = await Promise.all([
    scoped(client, req.tenantId, 'deals').select('id, name, amount, status, stage_id').eq('contact_id', contact.id),
    scoped(client, req.tenantId, 'sales_activities').select('*').eq('contact_id', contact.id).order('created_at', { ascending: false })
  ]);
  res.json({ contact, deals: deals || [], activities: activities || [] });
}));

router.patch('/sales/contacts/:id', requireRole('member'), validate(updateContactSchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data: before } = await scoped(client, req.tenantId, 'contacts').select('tags').eq('id', req.params.id).maybeSingle();
  if (!before) return res.status(404).json({ error: 'Contact not found.' });

  const patch = {};
  for (const [bodyKey, column] of [['displayName', 'display_name'], ['phone', 'phone'], ['email', 'email'], ['companyId', 'company_id'], ['jobTitle', 'job_title'], ['leadStatus', 'lead_status'], ['ownerId', 'owner_id'], ['tags', 'tags']]) {
    if (req.body[bodyKey] !== undefined) patch[column] = req.body[bodyKey];
  }
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nothing to update.' });

  const { data, error } = await scoped(client, req.tenantId, 'contacts').update(patch).eq('id', req.params.id).select('*').single();
  if (error) throw error;

  if (patch.tags) {
    const added = (patch.tags || []).filter((t) => !(before.tags || []).includes(t));
    for (const tag of added) {
      await fireTrigger(client, req.tenantId, 'contact_tag_added', { refType: 'contact', refId: data.id, contactId: data.id, tag });
    }
  }
  res.json({ contact: data });
}));

// -------------------------------------------------------------
// Pipelines & stages
// -------------------------------------------------------------

const DEFAULT_STAGES = [
  { name: 'New', probability: 10 },
  { name: 'Qualified', probability: 30 },
  { name: 'Proposal', probability: 60 },
  { name: 'Won', probability: 100, is_won: true },
  { name: 'Lost', probability: 0, is_lost: true }
];

router.get('/sales/pipelines', asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data: pipelines, error } = await scoped(client, req.tenantId, 'deal_pipelines').select('*').order('created_at');
  if (error) throw error;
  const { data: stages, error: stagesError } = await scoped(client, req.tenantId, 'deal_stages').select('*').order('position');
  if (stagesError) throw stagesError;
  const byPipeline = {};
  for (const s of stages || []) (byPipeline[s.pipeline_id] ||= []).push(s);
  res.json({ pipelines: (pipelines || []).map((p) => ({ ...p, stages: byPipeline[p.id] || [] })) });
}));

router.post('/sales/pipelines', requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { name } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required.' });

  const { data: pipeline, error } = await client.from('deal_pipelines').insert({ tenant_id: req.tenantId, name, is_default: false }).select('*').single();
  if (error) throw error;

  const stageRows = DEFAULT_STAGES.map((s, i) => ({
    tenant_id: req.tenantId, pipeline_id: pipeline.id, name: s.name, position: i, probability: s.probability,
    is_won: !!s.is_won, is_lost: !!s.is_lost
  }));
  const { data: stages, error: stagesError } = await client.from('deal_stages').insert(stageRows).select('*');
  if (stagesError) throw stagesError;

  res.status(201).json({ pipeline: { ...pipeline, stages } });
}));

// -------------------------------------------------------------
// Deals
// -------------------------------------------------------------

router.get('/sales/deals', asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  let query = scoped(client, req.tenantId, 'deals').select('*').order('created_at', { ascending: false });
  if (req.query.pipelineId) query = query.eq('pipeline_id', req.query.pipelineId);
  if (req.query.stageId) query = query.eq('stage_id', req.query.stageId);
  if (req.query.status) query = query.eq('status', req.query.status);
  const { data, error } = await query;
  if (error) throw error;
  res.json({ deals: data });
}));

router.post('/sales/deals', requireRole('member'), validate(dealSchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { name, pipelineId, stageId, amount, currency, contactId, companyId, ownerId, expectedCloseDate } = req.body;

  const { data: stage } = await scoped(client, req.tenantId, 'deal_stages').select('id, pipeline_id').eq('id', stageId).maybeSingle();
  if (!stage || stage.pipeline_id !== pipelineId) return res.status(400).json({ error: 'stageId must belong to pipelineId.' });

  const { data, error } = await client.from('deals').insert({
    tenant_id: req.tenantId, pipeline_id: pipelineId, stage_id: stageId, name, amount, currency,
    contact_id: contactId || null, company_id: companyId || null, owner_id: ownerId || null, expected_close_date: expectedCloseDate || null
  }).select('*').single();
  if (error) throw error;

  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'sales.deal_created', targetType: 'deal', targetId: data.id, metadata: { name, amount } });
  res.status(201).json({ deal: data });
}));

router.get('/sales/deals/:id', asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data: deal, error } = await scoped(client, req.tenantId, 'deals').select('*').eq('id', req.params.id).maybeSingle();
  if (error) throw error;
  if (!deal) return res.status(404).json({ error: 'Deal not found.' });

  const [{ data: activities }, { data: history }] = await Promise.all([
    scoped(client, req.tenantId, 'sales_activities').select('*').eq('deal_id', deal.id).order('created_at', { ascending: false }),
    scoped(client, req.tenantId, 'deal_stage_history').select('*').eq('deal_id', deal.id).order('changed_at', { ascending: false })
  ]);
  res.json({ deal, activities: activities || [], history: history || [] });
}));

router.patch('/sales/deals/:id', requireRole('member'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const patch = {};
  for (const [bodyKey, column] of [['name', 'name'], ['amount', 'amount'], ['currency', 'currency'], ['contactId', 'contact_id'], ['companyId', 'company_id'], ['ownerId', 'owner_id'], ['expectedCloseDate', 'expected_close_date']]) {
    if (req.body[bodyKey] !== undefined) patch[column] = req.body[bodyKey];
  }
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nothing to update.' });
  patch.updated_at = new Date().toISOString();

  const { data, error } = await scoped(client, req.tenantId, 'deals').update(patch).eq('id', req.params.id).select('*').single();
  if (error || !data) return res.status(404).json({ error: 'Deal not found.' });
  res.json({ deal: data });
}));

router.post('/sales/deals/:id/move', requireRole('member'), validate(moveDealStageSchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data: deal } = await scoped(client, req.tenantId, 'deals').select('id, pipeline_id, stage_id, contact_id').eq('id', req.params.id).maybeSingle();
  if (!deal) return res.status(404).json({ error: 'Deal not found.' });

  const { data: stage } = await scoped(client, req.tenantId, 'deal_stages').select('*').eq('id', req.body.stageId).maybeSingle();
  if (!stage || stage.pipeline_id !== deal.pipeline_id) return res.status(400).json({ error: 'stageId must belong to the deal\'s own pipeline.' });

  const fromStageId = deal.stage_id;
  const { error } = await client.rpc('move_deal_stage', { p_deal_id: deal.id, p_tenant_id: req.tenantId, p_to_stage_id: stage.id, p_changed_by: req.userId });
  if (error) throw error;

  const { data: updated } = await scoped(client, req.tenantId, 'deals').select('*').eq('id', deal.id).single();

  const triggerType = stage.is_won ? 'deal_won' : stage.is_lost ? 'deal_lost' : 'deal_stage_changed';
  await fireTrigger(client, req.tenantId, triggerType, { refType: 'deal', refId: deal.id, dealId: deal.id, contactId: deal.contact_id, fromStageId, toStageId: stage.id, stageName: stage.name });

  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'sales.deal_moved', targetType: 'deal', targetId: deal.id, metadata: { fromStageId, toStageId: stage.id, stageName: stage.name } });
  res.json({ deal: updated });
}));

router.delete('/sales/deals/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { error } = await scoped(client, req.tenantId, 'deals').delete().eq('id', req.params.id);
  if (error) throw error;
  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'sales.deal_deleted', targetType: 'deal', targetId: req.params.id });
  res.json({ success: true });
}));

// -------------------------------------------------------------
// Sales activities
// -------------------------------------------------------------

router.get('/sales/activities', asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  let query = scoped(client, req.tenantId, 'sales_activities').select('*').order('created_at', { ascending: false });
  if (req.query.dealId) query = query.eq('deal_id', req.query.dealId);
  if (req.query.contactId) query = query.eq('contact_id', req.query.contactId);
  if (req.query.companyId) query = query.eq('company_id', req.query.companyId);
  if (req.query.status) query = query.eq('status', req.query.status);
  const { data, error } = await query;
  if (error) throw error;
  res.json({ activities: data });
}));

router.post('/sales/activities', requireRole('member'), validate(salesActivitySchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { type, subject, notes, contactId, companyId, dealId, dueAt, assignedTo } = req.body;
  const { data, error } = await client.from('sales_activities').insert({
    tenant_id: req.tenantId, type, subject, notes: notes || null, contact_id: contactId || null, company_id: companyId || null,
    deal_id: dealId || null, due_at: dueAt || null, assigned_to: assignedTo || null, created_by: req.userId
  }).select('*').single();
  if (error) throw error;
  res.status(201).json({ activity: data });
}));

router.patch('/sales/activities/:id', requireRole('member'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const patch = {};
  if (req.body.subject !== undefined) patch.subject = req.body.subject;
  if (req.body.notes !== undefined) patch.notes = req.body.notes;
  if (req.body.dueAt !== undefined) patch.due_at = req.body.dueAt;
  if (req.body.status !== undefined) {
    if (!['open', 'completed'].includes(req.body.status)) return res.status(400).json({ error: 'status must be "open" or "completed".' });
    patch.status = req.body.status;
    patch.completed_at = req.body.status === 'completed' ? new Date().toISOString() : null;
  }
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nothing to update.' });

  const { data, error } = await scoped(client, req.tenantId, 'sales_activities').update(patch).eq('id', req.params.id).select('*').single();
  if (error || !data) return res.status(404).json({ error: 'Activity not found.' });
  res.json({ activity: data });
}));

router.delete('/sales/activities/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { error } = await scoped(client, req.tenantId, 'sales_activities').delete().eq('id', req.params.id);
  if (error) throw error;
  res.json({ success: true });
}));

module.exports = router;
