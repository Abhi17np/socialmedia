/**
 * Marketing Hub's AI layer (Phase 9) — reuses lib/ai.js's exact Anthropic
 * client/error/metering pattern (same `getAnthropicClient()`,
 * `unavailableError()`, fail-closed-not-silent posture, same
 * `aiGenerationsPerMonth` cost center as Social Hub's Compose/Inbox AI)
 * rather than a second, drifting AI integration. Three concrete,
 * reviewable-by-a-human features from the task brief's AI roadmap:
 * campaign copy (email/SMS), a natural-language segment builder, and a
 * performance-insights narrative — each grounded in this tenant's own
 * real data (never invented numbers), never autonomous (every output is
 * a draft a human reviews before anything sends, same as draftPost/
 * draftReply already do). A tenant's `marketing_brand_voice` (migration
 * 032) is folded into every system prompt here as a real constraint, not
 * cosmetic — that's this phase's "guardrails" half of the roadmap, not a
 * separate feature.
 *
 * send-time optimization, predictive scoring beyond Phase 6's rule-based
 * engine, an NL journey-graph builder, and content repurposing are
 * explicitly deferred — see docs/MARKETING_HUB_IMPLEMENTATION.md's
 * Phase 9 scope decision for why.
 */
const { getAnthropicClient } = require('./ai');
const { validateTree, isV2Filter, SegmentValidationError } = require('./segmentCompiler');

const MODEL = 'claude-opus-5-5';

function unavailableError() {
  const err = new Error('AI Assist is not configured (ANTHROPIC_API_KEY in backend/.env).');
  err.statusCode = 503;
  return err;
}

function refusedError(stopDetails) {
  const err = new Error(`AI Assist declined to draft this (${(stopDetails && stopDetails.category) || 'policy'}) — try rephrasing.`);
  err.statusCode = 422;
  return err;
}

function textOf(response) {
  const block = response.content.find((b) => b.type === 'text');
  return block ? block.text.trim() : '';
}

function brandVoiceLine(brandVoice) {
  return brandVoice ? `Match this brand's voice: ${brandVoice}.` : '';
}

async function generateEmailCopy({ brief, tone, brandVoice }) {
  const anthropic = getAnthropicClient();
  if (!anthropic) throw unavailableError();

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    output_config: { effort: 'low' },
    system: [
      'You write marketing email copy. Respond with EXACTLY two lines: the first line is the subject (prefixed "Subject: "), the second is the body (prefixed "Body: ").',
      'No preamble, no explanation, no markdown formatting in the body — plain text a merge-tag renderer will drop straight into an email template.',
      tone ? `Tone: ${tone}.` : '',
      brandVoiceLine(brandVoice)
    ].filter(Boolean).join(' '),
    messages: [{ role: 'user', content: brief }]
  });
  if (response.stop_reason === 'refusal') throw refusedError(response.stop_details);

  const text = textOf(response);
  const subjectMatch = text.match(/Subject:\s*(.+)/i);
  const bodyMatch = text.match(/Body:\s*([\s\S]+)/i);
  return { subject: subjectMatch ? subjectMatch[1].trim() : '', body: bodyMatch ? bodyMatch[1].trim() : text };
}

async function generateSmsCopy({ brief, brandVoice }) {
  const anthropic = getAnthropicClient();
  if (!anthropic) throw unavailableError();

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 256,
    output_config: { effort: 'low' },
    system: [
      'You write SMS marketing copy. Respond with ONLY the message text — no preamble, no quotes, no subject line.',
      'Keep it under 300 characters (roughly 2 SMS segments) unless the brief explicitly asks for more.',
      brandVoiceLine(brandVoice)
    ].filter(Boolean).join(' '),
    messages: [{ role: 'user', content: brief }]
  });
  if (response.stop_reason === 'refusal') throw refusedError(response.stop_details);
  return { body: textOf(response) };
}

/**
 * Natural-language -> a real, VALIDATED v2 segment filter tree
 * (lib/segmentCompiler.js's own shape, same one SegmentRuleBuilder.jsx
 * already produces by hand). The model's raw output is parsed as JSON
 * and run through validateTree() before ever reaching the caller — an
 * AI hallucinating an unknown field/operator fails closed with a clear
 * error, never silently becomes a query compiled against the real DB.
 */
async function generateSegmentFilter({ description }) {
  const anthropic = getAnthropicClient();
  if (!anthropic) throw unavailableError();

  // The exact field/operator registry lib/segmentCompiler.js's
  // validateTree() enforces (lib/schemas.js's/SegmentRuleBuilder.jsx's
  // own ground truth) — spelled out verbatim so the model's output has
  // the best real chance of validating, not a paraphrase that looks
  // plausible but fails closed.
  const fieldSpec = [
    'tags (operators: contains_any, contains_all, not_contains — value: array of strings)',
    'lead_status (operators: eq, neq, in — value: "new"|"contacted"|"qualified"|"unqualified"|"customer")',
    'lifecycle_stage (operators: eq, neq, in — value: "subscriber"|"lead"|"mql"|"sql"|"opportunity"|"customer"|"evangelist"|"other")',
    'lead_score (operators: eq, neq, gt, gte, lt, lte — value: number)',
    'email (operators: is_set, not_set — no value)',
    'phone (operators: is_set, not_set — no value)',
    'channel_identity (operators: has, not_has — value: "whatsapp"|"instagram"|"facebook")',
    'consent_status (operator: eq — value: {"channel":"email"|"whatsapp"|"sms","status":"opted_in"|"opted_out"})',
    'deal_status (operator: eq — value: "open"|"won"|"lost")',
    'has_open_deal (operator: eq — value: true|false)'
  ].join('; ');

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    output_config: { effort: 'low' },
    system: [
      'You translate a plain-English audience description into a JSON filter tree for a CRM segment builder.',
      'Respond with ONLY a JSON object, no markdown fences, no explanation, shaped exactly like: {"logic":"AND"|"OR","children":[{"field":"...","operator":"...","value":...}, ...]} — a child may itself be a nested group ({"logic":...,"children":[...]}) instead of a leaf condition.',
      `Only use these fields and their listed operators/value shapes — using anything else will be rejected: ${fieldSpec}.`,
      'If the description genuinely cannot be expressed with these fields, respond with {"error": "<short reason>"} instead.'
    ].join(' '),
    messages: [{ role: 'user', content: description }]
  });
  if (response.stop_reason === 'refusal') throw refusedError(response.stop_details);

  let parsed;
  try {
    parsed = JSON.parse(textOf(response).replace(/^```json\s*|\s*```$/g, ''));
  } catch {
    const err = new Error('AI Assist could not produce a valid segment for that description — try rephrasing with specific fields (tags, lead score, lifecycle stage…).');
    err.statusCode = 422;
    throw err;
  }
  if (parsed.error) { const err = new Error(parsed.error); err.statusCode = 422; throw err; }

  const filter = { version: 2, root: parsed };
  try {
    if (!isV2Filter(filter)) throw new SegmentValidationError('Generated filter is not a valid v2 tree.');
    validateTree(filter.root);
  } catch (err) {
    if (err instanceof SegmentValidationError) { const e = new Error(`AI Assist produced an invalid segment: ${err.message}`); e.statusCode = 422; throw e; }
    throw err;
  }
  return { filter };
}

/** A short narrative over REAL numbers the caller already computed (Phase 8's /marketing/overview) — the model never sees or invents a metric, it only phrases ones already fetched from the real DB. */
async function generateInsights({ overview, brandVoice }) {
  const anthropic = getAnthropicClient();
  if (!anthropic) throw unavailableError();

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 512,
    output_config: { effort: 'low' },
    system: [
      'You write a short (3-5 sentence) performance summary for a marketing dashboard, using ONLY the numbers given — never invent a metric or trend not present in the data.',
      'Call out the single most actionable observation (e.g. a channel with an unusually low engagement rate, or a lot of unattributed revenue worth tracking better) rather than just restating every number.',
      brandVoiceLine(brandVoice)
    ].filter(Boolean).join(' '),
    messages: [{ role: 'user', content: JSON.stringify(overview) }]
  });
  if (response.stop_reason === 'refusal') throw refusedError(response.stop_details);
  return { summary: textOf(response) };
}

module.exports = { generateEmailCopy, generateSmsCopy, generateSegmentFilter, generateInsights };
