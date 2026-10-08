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

module.exports = { signupSchema, loginSchema, createPostSchema, checkoutSchema, addMemberSchema, updateMemberSchema };
