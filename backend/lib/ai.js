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
async function draftPost({ brief, platforms, tone }) {
  const anthropic = getAnthropicClient();
  if (!anthropic) throw unavailableError();

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2048,
    output_config: { effort: 'low' },
    system: `You draft social media posts for a business's official account. Write only the post text itself — no preamble, no explanation, no surrounding quotation marks, no hashtag spam unless the brief asks for hashtags. ${tone ? `Tone: ${tone}.` : ''} This post will be published as-is to: ${platforms.join(', ')}.`,
    messages: [{ role: 'user', content: brief }]
  });

  if (response.stop_reason === 'refusal') throw refusedError(response.stop_details);
  return { draft: textOf(response) };
}

// Grounded in this tenant's own data — the recent conversation with this
// contact and the team's own canned responses — rather than a generic
// chatbot reply. The human still reviews it in the reply box before
// POST /social/inbox/:id/reply actually sends anything.
async function draftReply({ contactName, platform, incomingMessage, history, savedReplies }) {
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
    `Channel: ${platform}. A human reviews this before sending — draft it exactly as it should go out.`
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

module.exports = { getAnthropicClient, draftPost, draftReply };
