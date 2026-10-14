-- Marketing Hub Phase 9: AI layer. One new column — a tenant's brand
-- voice, folded as a system-prompt guardrail into every AI generation
-- this phase adds (email/SMS copy, NL segment description), so "brand
-- voice" and "guardrails" from the task brief's AI roadmap are the same
-- mechanism, not two separate features. No new tables: every AI feature
-- here is a stateless generate-and-return-for-review call (same posture
-- as the existing lib/ai.js draftPost/draftReply — nothing in this
-- phase sends/acts autonomously either).
alter table tenants add column if not exists marketing_brand_voice text;
