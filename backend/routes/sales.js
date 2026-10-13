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
const {
  companySchema, contactSchema, updateContactSchema, dealSchema, moveDealStageSchema, salesActivitySchema,
  updatePipelineSchema, dealStageSchema, updateDealStageSchema, reorderStagesSchema,
  salesTargetSchema, updateSalesTargetSchema
} = require('../lib/schemas');

const router = express.Router();

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

router.get('/sales/companies', requireHub('sales'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { page, pageSize, from, to } = pageParams(req);
  let query = scoped(client, req.tenantId, 'companies').select('*', { count: 'exact' }).order('created_at', { ascending: false }).range(from, to);
  if (req.query.search) query = query.ilike('name', `%${req.query.search}%`);
  const { data, error, count } = await query;
  if (error) throw error;
  res.json({ companies: data, page, pageSize, total: count });
}));

router.post('/sales/companies', requireHub('sales'), requireRole('member'), validate(companySchema), asyncHandler(async (req, res) => {
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

router.get('/sales/companies/:id', requireHub('sales'), asyncHandler(async (req, res) => {
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

router.patch('/sales/companies/:id', requireHub('sales'), requireRole('member'), validate(companySchema), asyncHandler(async (req, res) => {
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

router.delete('/sales/companies/:id', requireHub('sales'), requireRole('admin'), asyncHandler(async (req, res) => {
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

router.get('/sales/contacts', requireHub('sales'), asyncHandler(async (req, res) => {
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

router.post('/sales/contacts', requireHub('sales'), requireRole('member'), validate(contactSchema), asyncHandler(async (req, res) => {
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

router.get('/sales/contacts/:id', requireHub('sales'), asyncHandler(async (req, res) => {
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

router.patch('/sales/contacts/:id', requireHub('sales'), requireRole('member'), validate(updateContactSchema), asyncHandler(async (req, res) => {
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

router.get('/sales/pipelines', requireHub('sales'), asyncHandler(async (req, res) => {
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

router.post('/sales/pipelines', requireHub('sales'), requireRole('admin'), asyncHandler(async (req, res) => {
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

router.patch('/sales/pipelines/:id', requireHub('sales'), requireRole('admin'), validate(updatePipelineSchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data, error } = await scoped(client, req.tenantId, 'deal_pipelines').update({ name: req.body.name }).eq('id', req.params.id).select('*').single();
  if (error || !data) return res.status(404).json({ error: 'Pipeline not found.' });
  res.json({ pipeline: data });
}));

router.delete('/sales/pipelines/:id', requireHub('sales'), requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { error } = await scoped(client, req.tenantId, 'deal_pipelines').delete().eq('id', req.params.id);
  if (error) {
    if (error.code === '23503') return res.status(409).json({ error: 'This pipeline has deals in it and cannot be deleted. Move or delete its deals first.' });
    throw error;
  }
  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'sales.pipeline_deleted', targetType: 'pipeline', targetId: req.params.id });
  res.json({ success: true });
}));

router.post('/sales/pipelines/:pipelineId/stages', requireHub('sales'), requireRole('admin'), validate(dealStageSchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data: pipeline } = await scoped(client, req.tenantId, 'deal_pipelines').select('id').eq('id', req.params.pipelineId).maybeSingle();
  if (!pipeline) return res.status(404).json({ error: 'Pipeline not found.' });

  const { count } = await scoped(client, req.tenantId, 'deal_stages').select('id', { count: 'exact', head: true }).eq('pipeline_id', pipeline.id);
  const { data, error } = await client.from('deal_stages').insert({
    tenant_id: req.tenantId, pipeline_id: pipeline.id, name: req.body.name, position: count || 0,
    probability: req.body.probability, is_won: req.body.isWon, is_lost: req.body.isLost,
    stale_after_days: req.body.staleAfterDays ?? null
  }).select('*').single();
  if (error) throw error;
  res.status(201).json({ stage: data });
}));

router.patch('/sales/stages/:id', requireHub('sales'), requireRole('admin'), validate(updateDealStageSchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const patch = {};
  for (const [bodyKey, column] of [['name', 'name'], ['probability', 'probability'], ['isWon', 'is_won'], ['isLost', 'is_lost'], ['staleAfterDays', 'stale_after_days']]) {
    if (req.body[bodyKey] !== undefined) patch[column] = req.body[bodyKey];
  }
  const { data, error } = await scoped(client, req.tenantId, 'deal_stages').update(patch).eq('id', req.params.id).select('*').single();
  if (error || !data) return res.status(404).json({ error: 'Stage not found.' });
  res.json({ stage: data });
}));

router.delete('/sales/stages/:id', requireHub('sales'), requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { error } = await scoped(client, req.tenantId, 'deal_stages').delete().eq('id', req.params.id);
  if (error) {
    if (error.code === '23503') return res.status(409).json({ error: 'This stage has deals in it and cannot be deleted. Move its deals to another stage first.' });
    throw error;
  }
  res.json({ success: true });
}));

router.post('/sales/pipelines/:pipelineId/stages/reorder', requireHub('sales'), requireRole('admin'), validate(reorderStagesSchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data: existing, error: existingError } = await scoped(client, req.tenantId, 'deal_stages').select('id').eq('pipeline_id', req.params.pipelineId);
  if (existingError) throw existingError;
  const validIds = new Set((existing || []).map((s) => s.id));
  if (req.body.stages.length !== validIds.size) return res.status(400).json({ error: 'Must include every stage in the pipeline exactly once.' });

  const seenPositions = new Set();
  for (const s of req.body.stages) {
    if (!validIds.has(s.id)) return res.status(400).json({ error: `Stage ${s.id} does not belong to this pipeline.` });
    if (seenPositions.has(s.position)) return res.status(400).json({ error: 'Duplicate position in reorder list.' });
    seenPositions.add(s.position);
  }

  // deal_stages has a unique(pipeline_id, position) constraint, so
  // swapping two stages' positions directly can collide mid-update (A
  // takes B's old slot before B has vacated it). Bump every stage to a
  // disjoint offset range first, then apply the final positions, so no
  // intermediate state ever repeats one.
  for (const s of req.body.stages) {
    const { error } = await scoped(client, req.tenantId, 'deal_stages').update({ position: s.position + 100000 }).eq('id', s.id);
    if (error) throw error;
  }
  for (const s of req.body.stages) {
    const { error } = await scoped(client, req.tenantId, 'deal_stages').update({ position: s.position }).eq('id', s.id);
    if (error) throw error;
  }

  const { data: updated, error } = await scoped(client, req.tenantId, 'deal_stages').select('*').eq('pipeline_id', req.params.pipelineId).order('position');
  if (error) throw error;
  res.json({ stages: updated });
}));

// -------------------------------------------------------------
// Deals
// -------------------------------------------------------------

router.get('/sales/deals', requireHub('sales'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  let query = scoped(client, req.tenantId, 'deals').select('*').order('created_at', { ascending: false });
  if (req.query.pipelineId) query = query.eq('pipeline_id', req.query.pipelineId);
  if (req.query.stageId) query = query.eq('stage_id', req.query.stageId);
  if (req.query.status) query = query.eq('status', req.query.status);
  const { data, error } = await query;
  if (error) throw error;

  // Stale ("rotting", Pipedrive's term) is computed here at query time
  // against each deal's own stage.stale_after_days threshold, never
  // stored — nothing to keep in sync when a threshold changes or a deal
  // moves. Only open deals can be stale; won/lost deals are done.
  const stageIds = [...new Set((data || []).map((d) => d.stage_id))];
  const { data: stages, error: stagesError } = stageIds.length
    ? await scoped(client, req.tenantId, 'deal_stages').select('id, stale_after_days').in('id', stageIds)
    : { data: [], error: null };
  if (stagesError) throw stagesError;
  const staleAfterByStage = new Map((stages || []).map((s) => [s.id, s.stale_after_days]));

  const now = Date.now();
  const deals = (data || []).map((d) => {
    const staleAfterDays = staleAfterByStage.get(d.stage_id);
    const isStale = d.status === 'open' && staleAfterDays != null &&
      (now - new Date(d.updated_at).getTime()) > staleAfterDays * 86400000;
    return { ...d, isStale };
  });
  res.json({ deals });
}));

router.post('/sales/deals', requireHub('sales'), requireRole('member'), validate(dealSchema), asyncHandler(async (req, res) => {
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

router.get('/sales/deals/:id', requireHub('sales'), asyncHandler(async (req, res) => {
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

router.patch('/sales/deals/:id', requireHub('sales'), requireRole('member'), asyncHandler(async (req, res) => {
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

router.post('/sales/deals/:id/move', requireHub('sales'), requireRole('member'), validate(moveDealStageSchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data: deal } = await scoped(client, req.tenantId, 'deals').select('id, pipeline_id, stage_id, contact_id').eq('id', req.params.id).maybeSingle();
  if (!deal) return res.status(404).json({ error: 'Deal not found.' });

  const { data: stage } = await scoped(client, req.tenantId, 'deal_stages').select('*').eq('id', req.body.stageId).maybeSingle();
  if (!stage || stage.pipeline_id !== deal.pipeline_id) return res.status(400).json({ error: 'stageId must belong to the deal\'s own pipeline.' });
  if (stage.is_lost && !req.body.lostReason) return res.status(400).json({ error: 'lostReason is required when moving a deal to a lost stage.' });

  const fromStageId = deal.stage_id;
  const { error } = await client.rpc('move_deal_stage', {
    p_deal_id: deal.id, p_tenant_id: req.tenantId, p_to_stage_id: stage.id, p_changed_by: req.userId,
    p_lost_reason: stage.is_lost ? req.body.lostReason : null
  });
  if (error) throw error;

  const { data: updated } = await scoped(client, req.tenantId, 'deals').select('*').eq('id', deal.id).single();

  const triggerType = stage.is_won ? 'deal_won' : stage.is_lost ? 'deal_lost' : 'deal_stage_changed';
  await fireTrigger(client, req.tenantId, triggerType, { refType: 'deal', refId: deal.id, dealId: deal.id, contactId: deal.contact_id, fromStageId, toStageId: stage.id, stageName: stage.name });

  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'sales.deal_moved', targetType: 'deal', targetId: deal.id, metadata: { fromStageId, toStageId: stage.id, stageName: stage.name } });
  res.json({ deal: updated });
}));

router.delete('/sales/deals/:id', requireHub('sales'), requireRole('admin'), asyncHandler(async (req, res) => {
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

router.get('/sales/activities', requireHub('sales'), asyncHandler(async (req, res) => {
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

router.post('/sales/activities', requireHub('sales'), requireRole('member'), validate(salesActivitySchema), asyncHandler(async (req, res) => {
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

router.patch('/sales/activities/:id', requireHub('sales'), requireRole('member'), asyncHandler(async (req, res) => {
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

  // Completing an activity against a deal counts as "touching" it —
  // Pipedrive's rotting timer resets on any logged activity, not just a
  // stage move, so a deal with recent calls/emails/meetings never shows
  // stale just because it hasn't changed stage.
  if (patch.status === 'completed' && data.deal_id) {
    await scoped(client, req.tenantId, 'deals').update({ updated_at: new Date().toISOString() }).eq('id', data.deal_id);
  }

  res.json({ activity: data });
}));

router.delete('/sales/activities/:id', requireHub('sales'), requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { error } = await scoped(client, req.tenantId, 'sales_activities').delete().eq('id', req.params.id);
  if (error) throw error;
  res.json({ success: true });
}));

// -------------------------------------------------------------
// Sales targets (admin-set revenue targets the dashboard compares
// actual won-revenue against — see migrations/017_sales_targets.sql)
// -------------------------------------------------------------

router.get('/sales/targets', requireHub('sales'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data, error } = await scoped(client, req.tenantId, 'sales_targets').select('*').order('period_start', { ascending: false });
  if (error) throw error;
  res.json({ targets: data });
}));

router.post('/sales/targets', requireHub('sales'), requireRole('admin'), validate(salesTargetSchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data, error } = await client.from('sales_targets').insert({
    tenant_id: req.tenantId, owner_id: req.body.ownerId || null, period_start: req.body.periodStart,
    period_end: req.body.periodEnd, target_amount: req.body.targetAmount
  }).select('*').single();
  if (error) {
    if (error.code === '23514') return res.status(400).json({ error: 'periodEnd must not be before periodStart.' });
    throw error;
  }
  res.status(201).json({ target: data });
}));

router.patch('/sales/targets/:id', requireHub('sales'), requireRole('admin'), validate(updateSalesTargetSchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const patch = {};
  for (const [bodyKey, column] of [['ownerId', 'owner_id'], ['periodStart', 'period_start'], ['periodEnd', 'period_end'], ['targetAmount', 'target_amount']]) {
    if (req.body[bodyKey] !== undefined) patch[column] = req.body[bodyKey];
  }
  patch.updated_at = new Date().toISOString();
  const { data, error } = await scoped(client, req.tenantId, 'sales_targets').update(patch).eq('id', req.params.id).select('*').single();
  if (error && error.code === '23514') return res.status(400).json({ error: 'periodEnd must not be before periodStart.' });
  if (error || !data) return res.status(404).json({ error: 'Target not found.' });
  res.json({ target: data });
}));

router.delete('/sales/targets/:id', requireHub('sales'), requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { error } = await scoped(client, req.tenantId, 'sales_targets').delete().eq('id', req.params.id);
  if (error) throw error;
  res.json({ success: true });
}));

// -------------------------------------------------------------
// Dashboard & Workspace — real rollups over the tables above, computed
// at request time (no stored/cached metrics, nothing to go stale).
// -------------------------------------------------------------

function defaultMonthRange() {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

router.get('/sales/dashboard', requireHub('sales'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const defaults = defaultMonthRange();
  const from = req.query.from || defaults.from;
  const to = req.query.to || defaults.to;

  const [{ data: deals, error: dealsError }, { data: stages, error: stagesError }, { data: users, error: usersError }, { data: targets, error: targetsError }] = await Promise.all([
    scoped(client, req.tenantId, 'deals').select('*'),
    scoped(client, req.tenantId, 'deal_stages').select('id, probability'),
    scoped(client, req.tenantId, 'users').select('id, email'),
    scoped(client, req.tenantId, 'sales_targets').select('*').lte('period_start', to).gte('period_end', from)
  ]);
  if (dealsError) throw dealsError;
  if (stagesError) throw stagesError;
  if (usersError) throw usersError;
  if (targetsError) throw targetsError;

  const probabilityByStage = new Map((stages || []).map((s) => [s.id, s.probability]));
  const userEmailById = new Map((users || []).map((u) => [u.id, u.email]));
  const inRange = (dateStr) => !!dateStr && dateStr.slice(0, 10) >= from && dateStr.slice(0, 10) <= to;

  const wonDeals = (deals || []).filter((d) => d.status === 'won' && inRange(d.closed_at));
  const lostDeals = (deals || []).filter((d) => d.status === 'lost' && inRange(d.closed_at));
  const openDeals = (deals || []).filter((d) => d.status === 'open');

  const revenue = wonDeals.reduce((sum, d) => sum + Number(d.amount), 0);
  const lostAmount = lostDeals.reduce((sum, d) => sum + Number(d.amount), 0);
  const pipelineValue = openDeals.reduce((sum, d) => sum + Number(d.amount), 0);
  const weightedForecast = openDeals
    .filter((d) => inRange(d.expected_close_date))
    .reduce((sum, d) => sum + Number(d.amount) * ((probabilityByStage.get(d.stage_id) || 0) / 100), 0);
  const conversionRate = (wonDeals.length + lostDeals.length) > 0 ? wonDeals.length / (wonDeals.length + lostDeals.length) : null;

  const { count: overdueActivitiesCount, error: overdueError } = await scoped(client, req.tenantId, 'sales_activities')
    .select('id', { count: 'exact', head: true }).eq('status', 'open').lt('due_at', new Date().toISOString());
  if (overdueError) throw overdueError;

  const performanceByOwner = new Map();
  for (const d of deals || []) {
    if (!d.owner_id) continue;
    const row = performanceByOwner.get(d.owner_id) || {
      ownerId: d.owner_id, ownerEmail: userEmailById.get(d.owner_id) || null,
      wonCount: 0, wonAmount: 0, openCount: 0, openValue: 0
    };
    if (d.status === 'won' && inRange(d.closed_at)) { row.wonCount += 1; row.wonAmount += Number(d.amount); }
    if (d.status === 'open') { row.openCount += 1; row.openValue += Number(d.amount); }
    performanceByOwner.set(d.owner_id, row);
  }

  const targetsOut = (targets || []).map((t) => {
    const actualAmount = (deals || [])
      .filter((d) => d.status === 'won' && inRange(d.closed_at) && (!t.owner_id || d.owner_id === t.owner_id))
      .reduce((sum, d) => sum + Number(d.amount), 0);
    const targetAmount = Number(t.target_amount);
    return { ...t, actualAmount, attainmentPct: targetAmount > 0 ? Math.round((actualAmount / targetAmount) * 1000) / 10 : null };
  });

  res.json({
    range: { from, to },
    revenue, lostAmount, pipelineValue, weightedForecast, conversionRate,
    wonCount: wonDeals.length, lostCount: lostDeals.length, openCount: openDeals.length,
    overdueActivitiesCount: overdueActivitiesCount || 0,
    targets: targetsOut,
    teamPerformance: [...performanceByOwner.values()]
  });
}));

router.get('/sales/workspace', requireHub('sales'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const userId = req.userId;
  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const todayEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
  const weekEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 7)).toISOString();

  const [
    { data: overdue, error: overdueError },
    { data: dueToday, error: dueTodayError },
    { data: upcoming, error: upcomingError },
    { data: ownedDeals, error: dealsError }
  ] = await Promise.all([
    scoped(client, req.tenantId, 'sales_activities').select('*').eq('assigned_to', userId).eq('status', 'open').lt('due_at', now.toISOString()).order('due_at'),
    scoped(client, req.tenantId, 'sales_activities').select('*').eq('assigned_to', userId).eq('status', 'open').gte('due_at', todayStart).lt('due_at', todayEnd).order('due_at'),
    scoped(client, req.tenantId, 'sales_activities').select('*').eq('assigned_to', userId).eq('status', 'open').gte('due_at', todayEnd).lt('due_at', weekEnd).order('due_at'),
    scoped(client, req.tenantId, 'deals').select('*').eq('owner_id', userId).eq('status', 'open')
  ]);
  if (overdueError) throw overdueError;
  if (dueTodayError) throw dueTodayError;
  if (upcomingError) throw upcomingError;
  if (dealsError) throw dealsError;

  const stageIds = [...new Set((ownedDeals || []).map((d) => d.stage_id))];
  const { data: ownedStages, error: ownedStagesError } = stageIds.length
    ? await scoped(client, req.tenantId, 'deal_stages').select('id, stale_after_days').in('id', stageIds)
    : { data: [], error: null };
  if (ownedStagesError) throw ownedStagesError;
  const staleAfterByStage = new Map((ownedStages || []).map((s) => [s.id, s.stale_after_days]));
  const nowMs = Date.now();
  const staleDeals = (ownedDeals || []).filter((d) => {
    const staleAfterDays = staleAfterByStage.get(d.stage_id);
    return staleAfterDays != null && (nowMs - new Date(d.updated_at).getTime()) > staleAfterDays * 86400000;
  });

  res.json({
    overdueActivities: overdue || [],
    dueTodayActivities: dueToday || [],
    upcomingActivities: upcoming || [],
    staleDeals,
    openDealsCount: (ownedDeals || []).length
  });
}));

module.exports = router;
