/**
 * Brand Memory (migration 037) — a tenant's persistent voice/
 * terminology/claims guardrails. Read once per AI call (lib/ai.js's
 * draftPost/draftReply/suggestHashtags/repurposeContent all take the
 * resulting context string), and checked again AFTER generation,
 * because an LLM system-prompt instruction is a strong nudge, not a
 * guarantee — belt-and-suspenders, not either/or.
 *
 * Optional by construction: getBrandProfile() always returns a usable
 * object, even for a tenant with no brand_profiles row, so every caller
 * can treat "no profile configured" and "profile configured but empty"
 * identically, with zero special-casing.
 */

const DEFAULT_PROFILE = Object.freeze({
  tone: null,
  audience: null,
  preferred_terms: [],
  banned_terms: [],
  prohibited_claims: [],
  approved_messaging: []
});

async function getBrandProfile(client, tenantId) {
  const { data } = await client.from('brand_profiles').select('*').eq('tenant_id', tenantId).maybeSingle();
  if (!data) return { ...DEFAULT_PROFILE };
  return {
    tone: data.tone || null,
    audience: data.audience || null,
    preferred_terms: data.preferred_terms || [],
    banned_terms: data.banned_terms || [],
    prohibited_claims: data.prohibited_claims || [],
    approved_messaging: data.approved_messaging || []
  };
}

/**
 * Turns a brand profile into a prompt-injectable instruction block.
 * Returns '' for a fully-unconfigured profile — no "Brand guidelines:"
 * section appears in the prompt at all, rather than an awkward empty
 * one, so an unconfigured tenant's prompts are byte-for-byte what they
 * were before this feature existed.
 */
function buildBrandContext(profile) {
  if (!profile) return '';
  const lines = [];
  if (profile.tone) lines.push(`Brand tone: ${profile.tone}.`);
  if (profile.audience) lines.push(`Audience: ${profile.audience}.`);
  if (profile.preferred_terms && profile.preferred_terms.length) {
    lines.push(`Prefer these terms where relevant: ${profile.preferred_terms.join(', ')}.`);
  }
  if (profile.banned_terms && profile.banned_terms.length) {
    lines.push(`Never use these words or phrases: ${profile.banned_terms.join(', ')}.`);
  }
  if (profile.prohibited_claims && profile.prohibited_claims.length) {
    lines.push(`Never make these claims: ${profile.prohibited_claims.join(', ')}.`);
  }
  if (profile.approved_messaging && profile.approved_messaging.length) {
    lines.push(`Where relevant, draw on these approved messages: ${profile.approved_messaging.join(' | ')}.`);
  }
  if (lines.length === 0) return '';
  return `\n\nBrand guidelines (follow strictly):\n${lines.join('\n')}`;
}

/**
 * Case-insensitive substring match against banned_terms/
 * prohibited_claims — deliberately literal, not semantic. It reliably
 * catches an exact repeat of a banned word or a prohibited claim
 * phrase; it will NOT catch a paraphrase that expresses the same
 * prohibited claim in different words. That's an honest limitation,
 * not a bug: a stronger check would need a second LLM call per
 * generation (cost + latency for every draft) or a real classifier
 * this app doesn't have, and either would risk a false sense of
 * semantic understanding this simple check doesn't claim to have.
 * Never blocks anything itself — every AI draft in this app is already
 * reviewed by a human before it can be sent, so this only returns
 * violations for the caller to show as a warning.
 */
function checkBrandViolations(text, profile) {
  if (!text || !profile) return [];
  const lower = text.toLowerCase();
  const violations = [];
  for (const term of profile.banned_terms || []) {
    if (term && lower.includes(term.toLowerCase())) violations.push({ type: 'banned_term', term });
  }
  for (const claim of profile.prohibited_claims || []) {
    if (claim && lower.includes(claim.toLowerCase())) violations.push({ type: 'prohibited_claim', term: claim });
  }
  return violations;
}

module.exports = { getBrandProfile, buildBrandContext, checkBrandViolations, DEFAULT_PROFILE };
