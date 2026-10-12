/**
 * Request body contracts — the typed edge the rest of the app trusts.
 * One file so a route's actual shape is one grep away, instead of
 * scattered across each route's own ad hoc checks.
 */
const { z } = require('zod');

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

module.exports = {
  signupSchema, loginSchema, createPostSchema, checkoutSchema, addMemberSchema, updateMemberSchema,
  savedReplySchema, draftPostSchema, whatsappEmbeddedSignupSchema, inboxReplySchema, updateInteractionSchema,
  INTERACTION_STATUSES, INTERACTION_PRIORITIES, changePasswordSchema, forgotPasswordSchema, resetPasswordSchema
};
