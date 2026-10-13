/**
 * Request body contracts — the typed edge the rest of the app trusts.
 * One file so a route's actual shape is one grep away, instead of
 * scattered across each route's own ad hoc checks.
 */
const { z } = require('zod');

// A form field left blank arrives as "" (not absent) — plain .optional()
// only tolerates the key being missing, so an empty string still fails
// .email()'s format check or .uuid()'s format check. This bit every
// optional email/uuid field fed by a <select>/<input> whose "none"
// value is "" (segment, company, owner, contact, deal pickers across
// Sales/Marketing/WhatsApp Hub forms) — coercing "" to undefined first
// is what .optional() is actually meant to cover here.
const optionalEmail = () => z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().email().optional());
const optionalUuid = () => z.preprocess((v) => (v === '' ? undefined : v), z.string().uuid().optional());
const nullableOptionalUuid = () => z.preprocess((v) => (v === '' ? undefined : v), z.string().uuid().nullable().optional());

const signupSchema = z.object({
  tenantName: z.string().trim().min(1).max(200),
  email: z.string().trim().email(),
  password: z.string().min(8).max(200)
});

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1)
});

const createPostSchema = z.object({
  content: z.string().max(10000).optional().default(''),
  mediaUrls: z.array(z.string().url()).optional().default([]),
  targetPlatforms: z.array(z.string()).min(1),
  targetAccountIds: z.array(z.string().uuid()).min(1),
  scheduledAt: z.string().datetime({ offset: true }).or(z.string().datetime()),
  idempotencyKey: z.string().min(1).max(200).optional()
});

const checkoutSchema = z.object({
  plan: z.enum(['starter', 'pro'])
});

const ROLES = ['viewer', 'member', 'admin', 'owner'];

const addMemberSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(8).max(200),
  role: z.enum(ROLES)
});

const updateMemberSchema = z.object({
  role: z.enum(ROLES)
});

const savedReplySchema = z.object({
  title: z.string().trim().min(1).max(100),
  body: z.string().trim().min(1).max(2000)
});

const draftPostSchema = z.object({
  brief: z.string().trim().min(1).max(2000),
  platforms: z.array(z.string()).min(1),
  tone: z.string().trim().max(100).optional()
});

const whatsappEmbeddedSignupSchema = z.object({
  code: z.string().trim().min(1).max(2000),
  wabaId: z.string().trim().min(1).max(100),
  phoneNumberId: z.string().trim().min(1).max(100).optional()
});

const inboxReplySchema = z.object({
  message: z.string().trim().min(1).max(4096)
});

const INTERACTION_STATUSES = ['open', 'under_review', 'closed'];
const INTERACTION_PRIORITIES = ['low', 'medium', 'high'];

// assignedTo's *value* shape is checked here; whether that id actually
// belongs to this tenant is a DB lookup the route itself still has to
// do — zod can't see across tables.
const updateInteractionSchema = z.object({
  interactionStatus: z.enum(INTERACTION_STATUSES).optional(),
  priority: z.enum(INTERACTION_PRIORITIES).optional(),
  assignedTo: z.string().uuid().nullable().optional()
}).refine(v => v.interactionStatus !== undefined || v.priority !== undefined || v.assignedTo !== undefined, {
  message: 'Nothing to update — pass interactionStatus, priority and/or assignedTo.'
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(200)
});

const forgotPasswordSchema = z.object({
  email: z.string().trim().email()
});

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8).max(200)
});

// Platform-admin-only — see routes/platform.js's PATCH /tenants/:id/hubs.
// Partial on purpose (enabling Sales without touching Marketing).
const updateHubsSchema = z.object({
  sales: z.boolean().optional(),
  marketing: z.boolean().optional()
}).refine(v => v.sales !== undefined || v.marketing !== undefined, {
  message: 'Nothing to update — pass sales and/or marketing.'
});

const templateSchema = z.object({
  name: z.string().trim().regex(/^[a-z0-9_]+$/, 'Lowercase letters, numbers and underscores only (Meta template naming rules).').min(1).max(100),
  language: z.string().trim().min(2).max(10).default('en_US'),
  category: z.enum(['utility', 'marketing', 'authentication']).default('utility'),
  bodyText: z.string().trim().min(1).max(1024),
  variableSamples: z.array(z.string().max(200)).max(10).optional().default([]),
  socialAccountId: z.string().uuid()
});

const segmentSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).optional(),
  filter: z.object({
    tags: z.array(z.string().max(100)).optional(),
    hasPhone: z.boolean().optional(),
    hasEmail: z.boolean().optional(),
    leadStatus: z.string().max(50).optional(),
    search: z.string().max(200).optional()
  }).optional().default({})
});

const whatsappCampaignSchema = z.object({
  name: z.string().trim().min(1).max(200),
  socialAccountId: z.string().uuid(),
  templateId: z.string().uuid(),
  segmentId: optionalUuid(),
  contactIds: z.array(z.string().uuid()).max(10000).optional(),
  variableValues: z.array(z.string().max(200)).max(10).optional().default([]),
  scheduledAt: z.string().datetime({ offset: true }).or(z.string().datetime()).optional()
}).refine(v => v.segmentId || (v.contactIds && v.contactIds.length > 0), {
  message: 'Provide either segmentId or a non-empty contactIds list.'
});

const companySchema = z.object({
  name: z.string().trim().min(1).max(200),
  domain: z.string().trim().max(200).optional(),
  industry: z.string().trim().max(100).optional(),
  size: z.enum(['1-10', '11-50', '51-200', '201-500', '500+']).optional(),
  phone: z.string().trim().max(50).optional(),
  address: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(5000).optional(),
  ownerId: optionalUuid()
});

const contactSchema = z.object({
  displayName: z.string().trim().min(1).max(200),
  phone: z.string().trim().max(50).optional(),
  email: optionalEmail(),
  companyId: optionalUuid(),
  jobTitle: z.string().trim().max(150).optional(),
  leadStatus: z.enum(['new', 'contacted', 'qualified', 'unqualified', 'customer']).optional(),
  ownerId: optionalUuid(),
  tags: z.array(z.string().trim().max(50)).max(20).optional()
});

const updateContactSchema = z.object({
  displayName: z.string().trim().min(1).max(200).optional(),
  phone: z.string().trim().max(50).optional(),
  email: optionalEmail(),
  companyId: nullableOptionalUuid(),
  jobTitle: z.string().trim().max(150).optional(),
  leadStatus: z.enum(['new', 'contacted', 'qualified', 'unqualified', 'customer']).optional(),
  ownerId: nullableOptionalUuid(),
  tags: z.array(z.string().trim().max(50)).max(20).optional()
}).refine(v => Object.keys(v).length > 0, { message: 'Nothing to update.' });

const dealSchema = z.object({
  name: z.string().trim().min(1).max(200),
  pipelineId: z.string().uuid(),
  stageId: z.string().uuid(),
  amount: z.number().min(0).max(1e12).optional().default(0),
  currency: z.string().trim().length(3).optional().default('INR'),
  contactId: optionalUuid(),
  companyId: optionalUuid(),
  ownerId: optionalUuid(),
  expectedCloseDate: z.string().trim().max(10).optional()
});

const moveDealStageSchema = z.object({
  stageId: z.string().uuid(),
  lostReason: z.string().trim().min(1).max(500).optional()
});

const updatePipelineSchema = z.object({
  name: z.string().trim().min(1).max(200)
});

const dealStageSchema = z.object({
  name: z.string().trim().min(1).max(100),
  probability: z.number().int().min(0).max(100).optional().default(0),
  isWon: z.boolean().optional().default(false),
  isLost: z.boolean().optional().default(false),
  staleAfterDays: z.number().int().min(1).max(3650).nullable().optional()
});

const updateDealStageSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  probability: z.number().int().min(0).max(100).optional(),
  isWon: z.boolean().optional(),
  isLost: z.boolean().optional(),
  staleAfterDays: z.number().int().min(1).max(3650).nullable().optional()
}).refine(v => Object.keys(v).length > 0, { message: 'Nothing to update.' });

const reorderStagesSchema = z.object({
  stages: z.array(z.object({ id: z.string().uuid(), position: z.number().int().min(0) })).min(1)
});

const salesActivitySchema = z.object({
  type: z.enum(['call', 'email', 'meeting', 'note', 'task']),
  subject: z.string().trim().min(1).max(300),
  notes: z.string().trim().max(5000).optional(),
  contactId: optionalUuid(),
  companyId: optionalUuid(),
  dealId: optionalUuid(),
  dueAt: z.string().datetime({ offset: true }).or(z.string().datetime()).optional(),
  assignedTo: optionalUuid()
});

const LEAD_SCORING_CONDITION_TYPES = ['has_email', 'has_phone', 'has_company', 'tag_equals', 'lead_status_equals'];
const CONDITION_TYPES_NEEDING_VALUE = ['tag_equals', 'lead_status_equals'];

const leadScoringRuleSchema = z.object({
  name: z.string().trim().min(1).max(200),
  conditionType: z.enum(LEAD_SCORING_CONDITION_TYPES),
  conditionValue: z.string().trim().max(100).optional(),
  points: z.number().int().min(-1000).max(1000),
  isActive: z.boolean().optional().default(true)
}).refine(v => !CONDITION_TYPES_NEEDING_VALUE.includes(v.conditionType) || !!v.conditionValue, {
  message: 'conditionValue is required for tag_equals and lead_status_equals.',
  path: ['conditionValue']
});

const updateLeadScoringRuleSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  conditionType: z.enum(LEAD_SCORING_CONDITION_TYPES).optional(),
  conditionValue: z.string().trim().max(100).optional(),
  points: z.number().int().min(-1000).max(1000).optional(),
  isActive: z.boolean().optional()
}).refine(v => Object.keys(v).length > 0, { message: 'Nothing to update.' });

const salesTargetSchema = z.object({
  ownerId: nullableOptionalUuid(),
  periodStart: z.string().trim().min(1).max(10),
  periodEnd: z.string().trim().min(1).max(10),
  targetAmount: z.number().min(0).max(1e12)
});

const updateSalesTargetSchema = z.object({
  ownerId: nullableOptionalUuid(),
  periodStart: z.string().trim().min(1).max(10).optional(),
  periodEnd: z.string().trim().min(1).max(10).optional(),
  targetAmount: z.number().min(0).max(1e12).optional()
}).refine(v => Object.keys(v).length > 0, { message: 'Nothing to update.' });

const marketingCampaignSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  segmentId: optionalUuid(),
  startDate: z.string().trim().max(10).optional(),
  endDate: z.string().trim().max(10).optional()
});

const automationRuleSchema = z.object({
  name: z.string().trim().min(1).max(200),
  triggerType: z.enum(['contact_created', 'contact_tag_added', 'deal_stage_changed', 'deal_won', 'deal_lost']),
  triggerConfig: z.record(z.string(), z.any()).optional().default({}),
  actionType: z.enum(['add_tag', 'remove_tag', 'create_task']),
  actionConfig: z.record(z.string(), z.any()).optional().default({}),
  isActive: z.boolean().optional().default(true)
});

module.exports = {
  signupSchema, loginSchema, createPostSchema, checkoutSchema, addMemberSchema, updateMemberSchema,
  savedReplySchema, draftPostSchema, whatsappEmbeddedSignupSchema, inboxReplySchema, updateInteractionSchema,
  INTERACTION_STATUSES, INTERACTION_PRIORITIES, changePasswordSchema, forgotPasswordSchema, resetPasswordSchema,
  updateHubsSchema, templateSchema, segmentSchema, whatsappCampaignSchema,
  companySchema, contactSchema, updateContactSchema, dealSchema, moveDealStageSchema, salesActivitySchema,
  updatePipelineSchema, dealStageSchema, updateDealStageSchema, reorderStagesSchema,
  salesTargetSchema, updateSalesTargetSchema,
  leadScoringRuleSchema, updateLeadScoringRuleSchema, LEAD_SCORING_CONDITION_TYPES,
  marketingCampaignSchema, automationRuleSchema
};
