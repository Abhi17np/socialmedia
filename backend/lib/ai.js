/**
 * AI Assist — the one place that knows about model/effort/prompt choices
 * for every AI feature in the product, so Compose and Inbox don't each
 * grow their own Anthropic call with its own drift. Deliberately NOT an
 * autonomous agent: every draft here is reviewed and sent by a human
 * (Composer's Publish button, Inbox's Send reply button) — nothing in
 * this file ever posts or messages on its own. See lib/entitlements.js
 * for the per-tenant monthly cap this is metered against.
 */
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-opus-5-5';

let client = null;
function getAnthropicClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

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
  const block = response.content.find(b => b.type === 'text');
  return block ? block.text.trim() : '';
}

// Short, chat-shaped completions, not long-horizon reasoning — low effort
// keeps both latency and per-draft cost down without hurting quality on
// a task this templated. See the plan limits in lib/plans.js for the
// per-tenant monthly ceiling this draws against.
async function draftPost({ brief, platforms, tone, brandContext }) {
  const anthropic = getAnthropicClient();
  if (!anthropic) throw unavailableError();

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2048,
    output_config: { effort: 'low' },
    system: `You draft social media posts for a business's official account. Write only the post text itself — no preamble, no explanation, no surrounding quotation marks, no hashtag spam unless the brief asks for hashtags. ${tone ? `Tone: ${tone}.` : ''} This post will be published as-is to: ${platforms.join(', ')}.${brandContext || ''}`,
    messages: [{ role: 'user', content: brief }]
  });

  if (response.stop_reason === 'refusal') throw refusedError(response.stop_details);
  return { draft: textOf(response) };
}

// Grounded in this tenant's own data — the recent conversation with this
// contact and the team's own canned responses — rather than a generic
// chatbot reply. The human still reviews it in the reply box before
// POST /social/inbox/:id/reply actually sends anything.
async function draftReply({ contactName, platform, incomingMessage, history, savedReplies, brandContext }) {
  const anthropic = getAnthropicClient();
  if (!anthropic) throw unavailableError();

  const name = contactName || 'the customer';
  const historyBlock = (history || [])
    .map(h => `${h.direction === 'outbound' ? 'Us' : name}: ${h.text}`)
    .join('\n');
  const savedReplyBlock = (savedReplies || []).map(r => `- ${r.title}: ${r.body}`).join('\n');

  const system = [
    "You draft the next reply in a business's unified support inbox.",
    'Write only the reply text — no preamble, no explanation, no surrounding quotation marks.',
    savedReplyBlock
      ? `Match this team's voice. Reuse one of these canned responses verbatim when it genuinely fits; otherwise write a short original reply in the same voice:\n${savedReplyBlock}`
      : "Write a short, professional reply in the business's voice.",
    `Channel: ${platform}. A human reviews this before sending — draft it exactly as it should go out.${brandContext || ''}`
  ].join('\n\n');

  const userContent = [
    historyBlock && `Recent conversation:\n${historyBlock}`,
    `${name}: ${incomingMessage}`
  ].filter(Boolean).join('\n\n');

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    output_config: { effort: 'low' },
    system,
    messages: [{ role: 'user', content: userContent }]
  });

  if (response.stop_reason === 'refusal') throw refusedError(response.stop_details);
  return { draft: textOf(response) };
}

// Hashtags only — Composer already has the post text (its own draft or
// hand-written); this is a second, cheap, separately-triggered call, not
// folded into draftPost, so a tenant can regenerate just the hashtags
// without losing a caption they already liked.
async function suggestHashtags({ content, platforms, brandContext }) {
  const anthropic = getAnthropicClient();
  if (!anthropic) throw unavailableError();

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 256,
    output_config: { effort: 'low' },
    system: [
      'You suggest hashtags for a social media post. Respond with ONLY a JSON array of hashtag strings (each starting with #, no spaces), no markdown fences, no explanation.',
      'Suggest 5-8 hashtags for Instagram/TikTok-style platforms, or 2-3 for LinkedIn-style ones, mixing a couple of broad/popular tags with a few specific/niche ones relevant to the actual content.',
      `This will be posted to: ${(platforms || []).join(', ') || 'social media'}.${brandContext || ''}`
    ].join(' '),
    messages: [{ role: 'user', content }]
  });
  if (response.stop_reason === 'refusal') throw refusedError(response.stop_details);

  try {
    const hashtags = JSON.parse(textOf(response).replace(/^```json\s*|\s*```$/g, ''));
    if (!Array.isArray(hashtags)) throw new Error('not an array');
    return { hashtags: hashtags.filter((h) => typeof h === 'string').slice(0, 10) };
  } catch {
    const err = new Error('AI Assist could not produce hashtag suggestions for this content — try rephrasing it.');
    err.statusCode = 422;
    throw err;
  }
}

// On-demand inbox triage (Inbox's "Analyze" action, same pull-based
// posture as draftReply — never runs automatically on message arrival).
// Classifies ONLY sentiment/urgency, both of which a human still reads
// and can override; nothing here routes, replies, or closes a
// conversation on its own.
async function classifyMessage({ text, platform }) {
  const anthropic = getAnthropicClient();
  if (!anthropic) throw unavailableError();

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 64,
    output_config: { effort: 'low' },
    system: [
      'You triage one inbound customer message from a business\'s social media inbox.',
      'Respond with ONLY a JSON object, no markdown fences, no explanation, shaped exactly like: {"sentiment":"positive"|"neutral"|"negative","urgent":true|false}.',
      '"urgent" means it needs a reply soon — an angry customer, a complaint, a time-sensitive question, a churn risk. A simple question or a compliment is not urgent.',
      `Channel: ${platform || 'social media'}.`
    ].join(' '),
    messages: [{ role: 'user', content: text }]
  });
  if (response.stop_reason === 'refusal') throw refusedError(response.stop_details);

  try {
    const parsed = JSON.parse(textOf(response).replace(/^```json\s*|\s*```$/g, ''));
    const sentiment = ['positive', 'neutral', 'negative'].includes(parsed.sentiment) ? parsed.sentiment : 'neutral';
    return { sentiment, urgent: !!parsed.urgent };
  } catch {
    const err = new Error('AI Assist could not classify this message.');
    err.statusCode = 422;
    throw err;
  }
}

// AI Content Repurposing Studio: one approved source turned into
// platform-tailored variants in a single call, each carrying the same
// core message — explicitly instructed not to invent new claims/facts,
// since this is a rewrite of approved content, not fresh drafting.
// Duplicate-content and media-requirement checks happen in
// lib/repurposing.js (pure, no network) after this returns; brand
// violation checks happen the same way every other AI output here does
// (lib/brandMemory.js's checkBrandViolations). The caller (routes/ai.js)
// still routes every resulting variant through the normal Composer/
// approval path — nothing here schedules or publishes anything.
async function repurposeContent({ sourceContent, targetPlatforms, brandContext }) {
  const anthropic = getAnthropicClient();
  if (!anthropic) throw unavailableError();

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2048,
    output_config: { effort: 'low' },
    system: [
      "You repurpose one piece of source content into platform-tailored variants for a business's official social accounts.",
      'Respond with ONLY a JSON object mapping each requested platform to its own variant text, no markdown fences, no explanation, shaped exactly like: {"facebook":"...","instagram":"..."}.',
      "Each variant must carry the same core message as the source — do not invent new claims or facts not present in it — but rewrite length/tone/structure for that platform's real norms (shorter and hashtag-light for LinkedIn, more casual and hashtag-friendly for Instagram, etc).",
      `Target platforms: ${targetPlatforms.join(', ')}.${brandContext || ''}`
    ].join(' '),
    messages: [{ role: 'user', content: sourceContent }]
  });
  if (response.stop_reason === 'refusal') throw refusedError(response.stop_details);

  try {
    const variants = JSON.parse(textOf(response).replace(/^```json\s*|\s*```$/g, ''));
    if (typeof variants !== 'object' || variants === null || Array.isArray(variants)) throw new Error('not an object');
    return { variants };
  } catch {
    const err = new Error('AI Assist could not repurpose this content — try rephrasing it.');
    err.statusCode = 422;
    throw err;
  }
}

module.exports = { getAnthropicClient, draftPost, draftReply, suggestHashtags, classifyMessage, repurposeContent };
