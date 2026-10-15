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

// The free-form values a contact/company/deal's custom_fields jsonb
// column holds — shape is whatever custom_field_definitions describes
// for that entity_type (migration 016), not something zod can see
// across tables, so this only bounds the JSON primitive types/size.
const customFieldsValue = () => z.record(z.string().max(100), z.union([z.string().max(2000), z.number(), z.boolean(), z.null()])).optional();

const signupSchema = z.object({
  tenantName: z.string().trim().min(1).max(200),
  email: z.string().trim().email(),
  password: z.string().min(8).max(200)
});

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1)
});

const recurrenceSchema = z.object({
  freq: z.enum(['daily', 'weekly', 'monthly']),
  until: z.string().datetime({ offset: true }).or(z.string().datetime())
}).optional();

const createPostSchema = z.object({
  content: z.string().max(10000).optional().default(''),
  mediaUrls: z.array(z.string().url()).optional().default([]),
  targetPlatforms: z.array(z.string()).min(1),
  targetAccountIds: z.array(z.string().uuid()).min(1),
  scheduledAt: z.string().datetime({ offset: true }).or(z.string().datetime()),
  idempotencyKey: z.string().min(1).max(200).optional(),
  recurrence: recurrenceSchema
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

const hashtagSuggestSchema = z.object({
  content: z.string().trim().min(1).max(10000),
  platforms: z.array(z.string()).min(1)
});

const CONFIDENCE_LEVELS = [0.90, 0.95, 0.99];

const createTrackedLinkSchema = z.object({
  destinationUrl: z.string().trim().url().max(2000),
  platform: z.string().trim().max(50).optional(),
  label: z.string().trim().max(200).optional()
});

const updateTrackedLinkSchema = z.object({
  scheduledPostId: z.string().uuid().nullable().optional(),
  label: z.string().trim().max(200).optional()
});

const createExperimentSchema = z.object({
  name: z.string().trim().min(1).max(200),
  variable: z.enum(['hook', 'caption', 'cta', 'format']),
  minSampleSize: z.number().int().min(10).max(1000000).optional().default(100),
  confidenceLevel: z.number().refine((v) => CONFIDENCE_LEVELS.includes(v), { message: 'confidenceLevel must be 0.90, 0.95, or 0.99' }).optional().default(0.95),
  minObservationHours: z.number().int().min(1).max(720).optional().default(24),
  variants: z.array(z.object({
    key: z.string().trim().min(1).max(10),
    scheduledPostId: z.string().uuid()
  })).length(2)
});

const repurposeSchema = z.object({
  sourceContent: z.string().trim().min(1).max(10000),
  targetPlatforms: z.array(z.string()).min(1).max(10),
  hasMedia: z.boolean().optional().default(false)
});

// A free-text array capped at 50 short entries — generous enough for
// real brand guidelines, bounded enough that a prompt-injection-style
// wall of text can't balloon every future AI call's system prompt.
const brandTermList = () => z.array(z.string().trim().min(1).max(200)).max(50).optional().default([]);

const brandMemorySchema = z.object({
  tone: z.string().trim().max(300).optional(),
  audience: z.string().trim().max(300).optional(),
  preferredTerms: brandTermList(),
  bannedTerms: brandTermList(),
  prohibitedClaims: brandTermList(),
  approvedMessaging: brandTermList()
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

// The v2 AND/OR tree's actual (field, operator, value) validity is
// checked by lib/segmentCompiler.js's validateTree(), which knows the
// full field/operator registry — zod here only needs to accept the
// general shape (a condition leaf OR a nested group) so a malformed
// body 400s before ever reaching the route, not the exact semantics.
const segmentConditionNodeSchema = z.object({ field: z.string().min(1).max(60), operator: z.string().min(1).max(30), value: z.any().optional() });
const segmentGroupNodeSchema = z.lazy(() => z.object({ logic: z.enum(['AND', 'OR']), children: z.array(z.union([segmentConditionNodeSchema, segmentGroupNodeSchema])).min(1).max(60) }));
const segmentFilterV2Schema = z.object({ version: z.literal(2), root: z.union([segmentConditionNodeSchema, segmentGroupNodeSchema]) });
const segmentFilterLegacySchema = z.object({
  tags: z.array(z.string().max(100)).optional(),
  hasPhone: z.boolean().optional(),
  hasEmail: z.boolean().optional(),
  leadStatus: z.string().max(50).optional(),
  search: z.string().max(200).optional()
});

const segmentSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).optional(),
  segmentType: z.enum(['dynamic', 'static']).optional().default('dynamic'),
  filter: z.union([segmentFilterV2Schema, segmentFilterLegacySchema]).optional().default({})
});

const segmentMembersSchema = z.object({
  contactIds: z.array(z.string().uuid()).min(1).max(5000)
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
  ownerId: optionalUuid(),
  customFields: customFieldsValue(),
  // Optimistic concurrency: present on an update, ignored on create.
  // See bump_version() trigger, migration 023.
  version: z.number().int().optional()
});

const contactSchema = z.object({
  displayName: z.string().trim().min(1).max(200),
  phone: z.string().trim().max(50).optional(),
  email: optionalEmail(),
  companyId: optionalUuid(),
  jobTitle: z.string().trim().max(150).optional(),
  leadStatus: z.enum(['new', 'contacted', 'qualified', 'unqualified', 'customer']).optional(),
  ownerId: optionalUuid(),
  tags: z.array(z.string().trim().max(50)).max(20).optional(),
  customFields: customFieldsValue()
});

const updateContactSchema = z.object({
  displayName: z.string().trim().min(1).max(200).optional(),
  phone: z.string().trim().max(50).optional(),
  email: optionalEmail(),
  companyId: nullableOptionalUuid(),
  jobTitle: z.string().trim().max(150).optional(),
  leadStatus: z.enum(['new', 'contacted', 'qualified', 'unqualified', 'customer']).optional(),
  ownerId: nullableOptionalUuid(),
  tags: z.array(z.string().trim().max(50)).max(20).optional(),
  customFields: customFieldsValue(),
  version: z.number().int().optional()
}).refine(v => Object.keys(v).length > 0, { message: 'Nothing to update.' });

// Duplicate merging: mergedFields reuses each entity's own create-schema
// field rules (same validation as every other write), just all-optional
// since only the fields the user actually overrode on the survivor are
// sent — everything else keeps the survivor's existing value.
const mergeContactsSchema = z.object({
  survivorId: z.string().uuid(),
  loserId: z.string().uuid(),
  mergedFields: contactSchema.omit({ customFields: true, tags: true }).partial().optional().default({})
}).refine(v => v.survivorId !== v.loserId, { message: 'survivorId and loserId must be different.' });

const mergeCompaniesSchema = z.object({
  survivorId: z.string().uuid(),
  loserId: z.string().uuid(),
  mergedFields: companySchema.omit({ customFields: true, version: true }).partial().optional().default({})
}).refine(v => v.survivorId !== v.loserId, { message: 'survivorId and loserId must be different.' });

const FORECAST_CATEGORIES = ['pipeline', 'best_case', 'commit', 'omitted'];

const SAVED_VIEW_LIST_TYPES = ['companies', 'contacts', 'deals'];

const savedViewSchema = z.object({
  listType: z.enum(SAVED_VIEW_LIST_TYPES),
  name: z.string().trim().min(1).max(100),
  filters: z.record(z.string(), z.any()).optional().default({}),
  sort: z.string().trim().max(50).optional(),
  visibleColumns: z.array(z.string().trim().max(50)).max(30).optional()
});

const updateSavedViewSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  filters: z.record(z.string(), z.any()).optional(),
  sort: z.string().trim().max(50).nullable().optional(),
  visibleColumns: z.array(z.string().trim().max(50)).max(30).nullable().optional()
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
  expectedCloseDate: z.string().trim().max(10).optional(),
  forecastCategory: z.enum(FORECAST_CATEGORIES).optional(),
  customFields: customFieldsValue()
});

const updateDealSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  amount: z.number().min(0).max(1e12).optional(),
  currency: z.string().trim().length(3).optional(),
  contactId: nullableOptionalUuid(),
  companyId: nullableOptionalUuid(),
  ownerId: nullableOptionalUuid(),
  expectedCloseDate: z.string().trim().max(10).nullable().optional(),
  forecastCategory: z.enum(FORECAST_CATEGORIES).optional(),
  customFields: customFieldsValue(),
  version: z.number().int().optional()
}).refine(v => Object.keys(v).length > 0, { message: 'Nothing to update.' });

const moveDealStageSchema = z.object({
  stageId: z.string().uuid(),
  lostReason: z.string().trim().min(1).max(500).optional()
});

const dealContactSchema = z.object({
  contactId: z.string().uuid(),
  role: z.string().trim().max(100).optional(),
  isPrimary: z.boolean().optional().default(false)
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

const CONTACT_BULK_ACTIONS = ['add_tag', 'remove_tag', 'set_owner', 'set_lead_status'];
const COMPANY_BULK_ACTIONS = ['set_owner', 'delete'];

const contactBulkActionSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  action: z.enum(CONTACT_BULK_ACTIONS),
  value: z.string().trim().max(100).nullable().optional()
});

const companyBulkActionSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  action: z.enum(COMPANY_BULK_ACTIONS),
  value: z.string().trim().max(100).nullable().optional()
});

const LEAD_SCORING_CONDITION_TYPES = ['has_email', 'has_phone', 'has_company', 'tag_equals', 'lead_status_equals', 'email_opened_any', 'email_clicked_any', 'form_submitted_any', 'journey_completed_any'];
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
  targetAmount: z.number().min(0).max(1e12),
  currency: z.string().trim().length(3).optional().default('INR')
});

const updateSalesTargetSchema = z.object({
  ownerId: nullableOptionalUuid(),
  periodStart: z.string().trim().min(1).max(10).optional(),
  periodEnd: z.string().trim().min(1).max(10).optional(),
  targetAmount: z.number().min(0).max(1e12).optional(),
  currency: z.string().trim().length(3).optional()
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
  actionType: z.enum(['add_tag', 'remove_tag', 'create_task', 'assign_owner']),
  actionConfig: z.record(z.string(), z.any()).optional().default({}),
  isActive: z.boolean().optional().default(true)
});

const SEQUENCE_ACTION_TYPES = ['create_task', 'add_tag', 'remove_tag'];

const sequenceSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional()
});

const updateSequenceSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).optional(),
  isActive: z.boolean().optional()
}).refine(v => Object.keys(v).length > 0, { message: 'Nothing to update.' });

const sequenceStepSchema = z.object({
  delayDays: z.number().int().min(0).max(365).optional().default(0),
  actionType: z.enum(SEQUENCE_ACTION_TYPES),
  actionConfig: z.record(z.string(), z.any()).optional().default({})
}).refine(v => v.actionType !== 'create_task' || !!v.actionConfig.subject, { message: 'actionConfig.subject is required for create_task steps.', path: ['actionConfig'] })
  .refine(v => !['add_tag', 'remove_tag'].includes(v.actionType) || !!v.actionConfig.tag, { message: 'actionConfig.tag is required for add_tag/remove_tag steps.', path: ['actionConfig'] });

const sequenceEnrollSchema = z.object({
  contactId: z.string().uuid(),
  dealId: optionalUuid()
});

const CUSTOM_FIELD_ENTITY_TYPES = ['contact', 'company', 'deal'];
const CUSTOM_FIELD_TYPES = ['text', 'number', 'date', 'boolean', 'select'];

const customFieldDefinitionSchema = z.object({
  entityType: z.enum(CUSTOM_FIELD_ENTITY_TYPES),
  fieldKey: z.string().trim().min(1).max(100).regex(/^[a-z][a-z0-9_]*$/, 'fieldKey must be lowercase letters, numbers and underscores, starting with a letter.'),
  label: z.string().trim().min(1).max(200),
  fieldType: z.enum(CUSTOM_FIELD_TYPES).optional().default('text'),
  options: z.array(z.string().trim().max(100)).max(50).optional().default([]),
  isRequired: z.boolean().optional().default(false),
  position: z.number().int().min(0).max(1000).optional().default(0)
}).refine(v => v.fieldType !== 'select' || v.options.length > 0, { message: 'options is required when fieldType is "select".', path: ['options'] });

const updateCustomFieldDefinitionSchema = z.object({
  label: z.string().trim().min(1).max(200).optional(),
  fieldType: z.enum(CUSTOM_FIELD_TYPES).optional(),
  options: z.array(z.string().trim().max(100)).max(50).optional(),
  isRequired: z.boolean().optional(),
  position: z.number().int().min(0).max(1000).optional()
}).refine(v => Object.keys(v).length > 0, { message: 'Nothing to update.' });

const CONSENT_CHANNELS = ['email', 'whatsapp', 'sms'];

const preferenceUpdateSchema = z.object({
  channels: z.record(z.enum(CONSENT_CHANNELS), z.enum(['opted_in', 'opted_out'])).optional().default({}),
  globalOptOut: z.boolean().optional()
}).refine(v => Object.keys(v.channels).length > 0 || v.globalOptOut !== undefined, { message: 'Nothing to update.' });

const SUPPRESSION_REASONS = ['hard_bounce', 'complaint', 'manual', 'unsubscribe_link', 'global_unsubscribe'];

const suppressionCreateSchema = z.object({
  channel: z.enum(CONSENT_CHANNELS),
  identifier: z.string().trim().min(3).max(320),
  reason: z.enum(SUPPRESSION_REASONS).optional().default('manual')
});

const contactConsentUpdateSchema = z.object({
  channel: z.enum(CONSENT_CHANNELS),
  status: z.enum(['opted_in', 'opted_out']),
  reason: z.string().trim().max(500).optional(),
  version: z.number().int().optional()
});

// ----------------------------------------------------------- Email marketing

const EMAIL_PROVIDERS = ['mock', 'smtp', 'sendgrid', 'resend'];

const emailConnectionSchema = z.object({
  provider: z.enum(EMAIL_PROVIDERS),
  fromName: z.string().trim().min(1).max(200),
  fromEmail: z.string().trim().email(),
  replyTo: optionalEmail(),
  config: z.object({
    host: z.string().trim().max(255).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    secure: z.boolean().optional(),
    user: z.string().trim().max(255).optional()
  }).optional().default({}),
  secret: z.string().trim().max(2000).optional() // SMTP password / provider API key — write-only, never read back
}).refine(v => v.provider !== 'smtp' || (v.config.host && v.config.port && v.config.user), { message: 'SMTP needs config.host, config.port and config.user.', path: ['config'] });

const emailDomainSchema = z.object({
  domain: z.string().trim().toLowerCase().min(3).max(255).regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'Enter a bare domain, e.g. mail.example.com'),
  dkimSelector: z.string().trim().max(100).optional()
});

const EMAIL_BLOCK_TYPES = ['heading', 'text', 'image', 'button', 'divider', 'spacer'];
const emailBlockSchema = z.object({
  type: z.enum(EMAIL_BLOCK_TYPES),
  text: z.string().max(5000).optional(),
  src: z.string().max(2000).optional(),
  alt: z.string().max(300).optional(),
  label: z.string().max(100).optional(),
  href: z.string().max(2000).optional(),
  height: z.number().int().min(1).max(200).optional()
});

const emailTemplateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  subject: z.string().trim().max(300).optional().default(''),
  preheader: z.string().trim().max(300).optional(),
  blocks: z.array(emailBlockSchema).max(100).optional().default([]),
  brand: z.object({ logoUrl: z.string().max(2000).optional(), primaryColor: z.string().trim().max(20).optional(), fontFamily: z.string().trim().max(100).optional() }).optional().default({}),
  version: z.number().int().optional()
});

const emailAbTestSchema = z.object({
  variants: z.array(z.object({ key: z.string().trim().min(1).max(20), subject: z.string().trim().min(1).max(300) })).min(2).max(4),
  splitPercent: z.number().min(1).max(99).optional().default(50),
  winnerMetric: z.enum(['opens', 'clicks']).optional().default('opens'),
  // Hours after the campaign finishes sending before lib/email/abWinnerSweep.js
  // auto-picks a winner by winnerMetric and writes it to winnerKey. Omit to
  // never auto-decide (reporting-only, same as before this field existed).
  decisionHours: z.number().min(1).max(168).optional()
}).optional();

const emailCampaignSchema = z.object({
  name: z.string().trim().min(1).max(200),
  templateId: z.string().uuid(),
  segmentId: z.string().uuid(),
  subject: z.string().trim().max(300).optional(),
  preheader: z.string().trim().max(300).optional(),
  fromName: z.string().trim().max(200).optional(),
  fromEmail: optionalEmail(),
  sendMode: z.enum(['immediate', 'scheduled']).optional().default('immediate'),
  scheduledAt: z.string().trim().optional(),
  timezone: z.string().trim().max(100).optional().default('UTC'),
  abTest: emailAbTestSchema
}).refine(v => v.sendMode !== 'scheduled' || !!v.scheduledAt, { message: 'scheduledAt is required when sendMode is "scheduled".', path: ['scheduledAt'] });

const emailSendTestSchema = z.object({ to: z.string().trim().email() });

// -------------------------------------------------------------------- SMS

const SMS_PROVIDERS = ['mock', 'twilio', 'msg91'];

const smsConnectionSchema = z.object({
  provider: z.enum(SMS_PROVIDERS),
  fromNumber: z.string().trim().min(1).max(20),
  config: z.object({
    accountSid: z.string().trim().max(255).optional(),      // twilio
    dltEntityId: z.string().trim().max(255).optional(),     // msg91 / India TRAI DLT
    dltTemplateId: z.string().trim().max(255).optional()
  }).optional().default({}),
  secret: z.string().trim().max(2000).optional() // auth token / API key — write-only, never read back
}).refine(v => v.provider !== 'twilio' || v.config.accountSid, { message: 'Twilio needs config.accountSid.', path: ['config'] })
  .refine(v => v.provider !== 'msg91' || (v.config.dltEntityId && v.config.dltTemplateId), { message: 'MSG91 needs config.dltEntityId and config.dltTemplateId (India TRAI DLT registration).', path: ['config'] });

const smsCampaignSchema = z.object({
  name: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(1600), // ~10 concatenated SMS segments
  segmentId: z.string().uuid(),
  version: z.number().int().optional()
});

// --------------------------------------------------------------- Journeys

// A node/edge's exact field validity (which actionType config fields are
// required, which operators a condition supports) is owned by
// lib/journeyGraph.js's validateGraph() and lib/journeyActions.js's
// executors — zod here only checks the general shape, same division of
// labor as the Phase 2 segment filter schema.
const journeyNodeSchema = z.object({
  id: z.string().trim().min(1).max(60),
  type: z.enum(['trigger', 'delay', 'condition', 'action', 'split']),
  actionType: z.string().max(40).optional(),
  config: z.record(z.string(), z.any()).optional().default({})
});
const journeyEdgeSchema = z.object({
  id: z.string().trim().min(1).max(60),
  source: z.string().trim().min(1).max(60),
  target: z.string().trim().min(1).max(60),
  branch: z.enum(['yes', 'no']).optional(),
  weight: z.number().positive().optional()
});
const journeyGraphSchema = z.object({
  nodes: z.array(journeyNodeSchema).min(1).max(100),
  edges: z.array(journeyEdgeSchema).max(200)
});

const JOURNEY_TRIGGER_TYPES = ['contact_created', 'contact_tag_added', 'deal_stage_changed', 'deal_won', 'deal_lost', 'email_opened', 'email_clicked', 'form_submitted', 'became_mql'];

const journeySchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  triggerType: z.enum(JOURNEY_TRIGGER_TYPES),
  triggerConfig: z.record(z.string(), z.any()).optional().default({}),
  graph: journeyGraphSchema,
  reentryAllowed: z.boolean().optional().default(false),
  goalConfig: z.object({ field: z.string(), operator: z.string(), value: z.any() }).optional(),
  version: z.number().int().optional()
});

const journeyEnrollSchema = z.object({ contactId: z.string().uuid() });

// Field-level semantics (key uniqueness, "needs at least one email/phone
// field") are owned by lib/leadForms.js's validateFieldDefinitions — same
// division of labor as journeyGraphSchema/journeyGraph.js: this just
// checks the structural shape so a malformed field can't reach the
// handler at all.
const leadFormFieldSchema = z.object({
  key: z.string().trim().min(1).max(50),
  label: z.string().trim().min(1).max(200),
  type: z.enum(['text', 'email', 'phone', 'textarea', 'select', 'checkbox']),
  required: z.boolean().optional().default(false),
  options: z.array(z.string().trim().min(1).max(200)).max(50).optional()
});

const leadFormSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  fields: z.array(leadFormFieldSchema).min(1).max(20),
  consentRequired: z.boolean().optional().default(true),
  consentText: z.string().trim().min(1).max(500).optional(),
  thankYouMessage: z.string().trim().min(1).max(500).optional(),
  redirectUrl: z.string().trim().url().max(2000).optional(),
  version: z.number().int().optional()
});

const aiEmailCopySchema = z.object({
  brief: z.string().trim().min(1).max(2000),
  tone: z.string().trim().max(100).optional()
});

const aiSmsCopySchema = z.object({
  brief: z.string().trim().min(1).max(2000)
});

const aiSegmentFilterSchema = z.object({
  description: z.string().trim().min(1).max(2000)
});

const aiInsightsSchema = z.object({
  overview: z.record(z.any())
});

module.exports = {
  signupSchema, loginSchema, createPostSchema, checkoutSchema, addMemberSchema, updateMemberSchema, hashtagSuggestSchema,
  savedReplySchema, draftPostSchema, whatsappEmbeddedSignupSchema, inboxReplySchema, updateInteractionSchema,
  repurposeSchema, brandMemorySchema, createExperimentSchema, CONFIDENCE_LEVELS,
  createTrackedLinkSchema, updateTrackedLinkSchema,
  INTERACTION_STATUSES, INTERACTION_PRIORITIES, changePasswordSchema, forgotPasswordSchema, resetPasswordSchema,
  updateHubsSchema, templateSchema, segmentSchema, segmentMembersSchema, whatsappCampaignSchema,
  companySchema, contactSchema, updateContactSchema, dealSchema, updateDealSchema, moveDealStageSchema, salesActivitySchema,
  dealContactSchema, FORECAST_CATEGORIES,
  updatePipelineSchema, dealStageSchema, updateDealStageSchema, reorderStagesSchema,
  salesTargetSchema, updateSalesTargetSchema,
  leadScoringRuleSchema, updateLeadScoringRuleSchema, LEAD_SCORING_CONDITION_TYPES,
  contactBulkActionSchema, companyBulkActionSchema,
  customFieldDefinitionSchema, updateCustomFieldDefinitionSchema, CUSTOM_FIELD_ENTITY_TYPES, CUSTOM_FIELD_TYPES,
  sequenceSchema, updateSequenceSchema, sequenceStepSchema, sequenceEnrollSchema, SEQUENCE_ACTION_TYPES,
  savedViewSchema, updateSavedViewSchema, SAVED_VIEW_LIST_TYPES,
  mergeContactsSchema, mergeCompaniesSchema,
  marketingCampaignSchema, automationRuleSchema,
  preferenceUpdateSchema, suppressionCreateSchema, contactConsentUpdateSchema, CONSENT_CHANNELS, SUPPRESSION_REASONS,
  emailConnectionSchema, emailDomainSchema, emailTemplateSchema, emailCampaignSchema, emailSendTestSchema, EMAIL_PROVIDERS, EMAIL_BLOCK_TYPES,
  smsConnectionSchema, smsCampaignSchema, SMS_PROVIDERS,
  journeySchema, journeyEnrollSchema, JOURNEY_TRIGGER_TYPES,
  leadFormSchema, leadFormFieldSchema,
  aiEmailCopySchema, aiSmsCopySchema, aiSegmentFilterSchema, aiInsightsSchema
};
