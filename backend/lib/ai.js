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

/**
 * Competitor Opportunity Radar's content-gap analysis — the one
 * genuinely qualitative piece of that feature (the rest is computed
 * directly from real numbers, see lib/competitorRadar.js). Reads a
 * sample of the tenant's own recent post captions and a competitor's
 * recent post captions (real text, fetched via the adapters'
 * fetchCompetitor()) and asks for themes the competitor covers that
 * the tenant's own sample doesn't — each suggestion required to cite
 * which actual competitor post(s) it's drawn from, so a human can
 * verify it against real evidence rather than take an unsourced claim
 * on faith (rule 3: ground in tenant data, show supporting evidence,
 * state uncertainty). This never runs automatically — a tenant
 * explicitly asks for it (POST /ai/compose/competitor-gaps), same
 * pull-based, metered, human-reviewed posture as every other AI
 * feature in this app.
 */
async function analyzeCompetitorGaps({ ownCaptions, competitorCaptions, competitorLabel, brandContext }) {
  const anthropic = getAnthropicClient();
  if (!anthropic) throw unavailableError();

  const ownBlock = ownCaptions.length > 0 ? ownCaptions.map((c, i) => `${i + 1}. ${c}`).join('\n') : '(no recent posts to compare against)';
  const competitorBlock = competitorCaptions.map((c, i) => `${i + 1}. ${c}`).join('\n');

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1536,
    output_config: { effort: 'low' },
    system: [
      `You compare a business's own recent social posts against ${competitorLabel}'s recent public posts to find content themes the competitor covers that the business hasn't touched recently.`,
      'Respond with ONLY a JSON array, no markdown fences, no explanation, each item shaped exactly like: {"theme":"...","evidence":[1,3],"suggestion":"..."}.',
      '"evidence" MUST be the 1-based index number(s) of the specific competitor post(s) below that support this theme — never invent a theme with no matching numbered post.',
      'Only report a theme if it genuinely does not appear in the business\'s own recent posts list; do not report something both sides already cover.',
      'Up to 5 themes. If nothing qualifies, respond with an empty JSON array [].' + (brandContext || '')
    ].join(' '),
    messages: [{ role: 'user', content: `Our own recent posts:\n${ownBlock}\n\n${competitorLabel}'s recent posts:\n${competitorBlock}` }]
  });
  if (response.stop_reason === 'refusal') throw refusedError(response.stop_details);

  try {
    const parsed = JSON.parse(textOf(response).replace(/^```json\s*|\s*```$/g, ''));
    if (!Array.isArray(parsed)) throw new Error('not an array');
    // Re-validate evidence indices against the real list server-side —
    // never trust the model's own citation to actually be in range,
    // since a hallucinated index would otherwise point at nothing (or
    // worse, silently point at the wrong post) when the UI resolves it.
    return {
      gaps: parsed
        .filter((g) => g && typeof g.theme === 'string' && Array.isArray(g.evidence))
        .map((g) => ({
          theme: g.theme,
          suggestion: typeof g.suggestion === 'string' ? g.suggestion : '',
          evidence: g.evidence.filter((i) => Number.isInteger(i) && i >= 1 && i <= competitorCaptions.length)
        }))
        .filter((g) => g.evidence.length > 0)
    };
  } catch {
    const err = new Error('AI Assist could not analyze these posts for content gaps — try again with different accounts.');
    err.statusCode = 422;
    throw err;
  }
}

/**
 * Crisis Intelligence's optional summary — the one qualitative step in
 * that feature, deliberately AFTER a real statistical surge is already
 * detected (lib/crisisDetection.js, zero AI involved in the detection
 * itself — see that file's header for why). Reads the actual messages
 * that make up the flagged window and asks for: the dominant theme(s)
 * driving it, and which of those messages most need a reply — each
 * theme required to cite which numbered message(s) it's drawn from, the
 * same evidence discipline analyzeCompetitorGaps() uses, re-validated
 * server-side below so a hallucinated citation can never reach a human
 * as "evidence." This never runs automatically — a human looks at an
 * open alert and explicitly asks for it (POST /ai/crisis-alerts/:id/
 * summarize), same pull-based, metered posture as every AI feature here.
 */
async function summarizeCrisis({ messages, brandContext }) {
  const anthropic = getAnthropicClient();
  if (!anthropic) throw unavailableError();

  const messageBlock = messages.map((m, i) => `${i + 1}. [${m.platform}] ${m.text || '(no text)'}`).join('\n');

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1536,
    output_config: { effort: 'low' },
    system: [
      'You read a surge of inbound social messages/comments/mentions a business received in a short window and summarize what\'s driving it.',
      'Respond with ONLY a JSON object, no markdown fences, no explanation, shaped exactly like:',
      '{"themes":[{"theme":"...","evidence":[1,3]}],"priorityMessages":[2,5],"note":"..."}',
      '"evidence" MUST be the 1-based index number(s) of the specific numbered messages below that support that theme — never invent a theme with no matching numbered message.',
      '"priorityMessages" is the 1-based indices of messages most urgently needing a human reply (angry/complaining/time-sensitive) — may be empty.',
      '"note" is one short sentence of overall context (e.g. whether this looks like one shared complaint or several unrelated things). State uncertainty plainly if the messages are too mixed to summarize confidently.',
      'Up to 5 themes.' + (brandContext || '')
    ].join(' '),
    messages: [{ role: 'user', content: `Messages in this window:\n${messageBlock}` }]
  });
  if (response.stop_reason === 'refusal') throw refusedError(response.stop_details);

  try {
    const parsed = JSON.parse(textOf(response).replace(/^```json\s*|\s*```$/g, ''));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.themes)) throw new Error('malformed shape');

    const validIndex = (i) => Number.isInteger(i) && i >= 1 && i <= messages.length;
    return {
      themes: parsed.themes
        .filter((t) => t && typeof t.theme === 'string' && Array.isArray(t.evidence))
        .map((t) => ({ theme: t.theme, evidence: t.evidence.filter(validIndex) }))
        .filter((t) => t.evidence.length > 0),
      priorityMessages: Array.isArray(parsed.priorityMessages) ? parsed.priorityMessages.filter(validIndex) : [],
      note: typeof parsed.note === 'string' ? parsed.note : ''
    };
  } catch {
    const err = new Error('AI Assist could not summarize this alert — try again, or review the messages directly.');
    err.statusCode = 422;
    throw err;
  }
}

/**
 * Marketing Decision Simulator's optional narrative — put ALREADY-FINAL,
 * deterministically-computed numbers (lib/decisionSimulator.js) into
 * plain English. AI never decides or adjusts the projection itself,
 * only comments on numbers it's handed; unlike every other grounded AI
 * feature in this app, there's no discrete list of "evidence items" to
 * cite and re-validate indices against here — the grounding instead is
 * that the model is told exactly which numbers it may reference and
 * instructed not to state any other one, and never to sharpen the
 * uncertainty this app's own math already reported as a range. This is
 * weaker grounding than citation-based evidence and is treated that way:
 * this narrative is offered as color on numbers already shown directly
 * in the UI, never as the source of the numbers themselves.
 */
async function explainScenario({ baseline, projection, frequencyMultiplier }) {
  const anthropic = getAnthropicClient();
  if (!anthropic) throw unavailableError();

  const facts = [
    `Current posting frequency: ${baseline.postsPerWeek.toFixed(1)} posts/week.`,
    `Current engagement rate: ${(baseline.engagementRate * 100).toFixed(2)}%.`,
    `Current follower growth: ${baseline.followerGrowthPerWeek.mean.toFixed(1)}/week on average, based on ${baseline.followerGrowthPerWeek.weeksOfData} weeks of history.`,
    `Requested change: posting frequency × ${frequencyMultiplier}${projection.wasClamped ? ` (clamped to × ${projection.appliedMultiplier} — a simple model like this one isn't credible further outside the observed range)` : ''}.`,
    `Projected posting frequency: ${projection.postsPerWeek.toFixed(1)} posts/week.`,
    `Projected engagement rate: unchanged, ${(projection.engagementRate * 100).toFixed(2)}% (this model does not predict whether posting more would raise or dilute it).`,
    `Projected follower growth: ${projection.followerGrowthPerWeek.mean.toFixed(1)}/week, with a 95% range of ${projection.followerGrowthPerWeek.low.toFixed(1)} to ${projection.followerGrowthPerWeek.high.toFixed(1)}.`,
    `Confidence: ${projection.confidence}${projection.confidence === 'low' ? ' (fewer than 4 weeks of follower-growth history — treat this range as a rough guide only)' : ''}.`
  ].join(' ');

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 512,
    output_config: { effort: 'low' },
    system: [
      'You explain a marketing posting-frequency projection to a small business owner in plain English, 3-4 sentences.',
      'You may reference ONLY the numbers given to you below — never state a number, percentage, or range that was not explicitly given.',
      'Never narrow, sharpen, or drop the stated uncertainty range — if confidence is "low," say so plainly rather than sounding more certain than the numbers support.',
      'Mention the one or two biggest caveats (the unchanged-engagement-rate assumption, and low confidence if applicable) rather than just repeating the optimistic number.',
      'No markdown, no bullet points, no preamble — plain prose only.'
    ].join(' '),
    messages: [{ role: 'user', content: facts }]
  });
  if (response.stop_reason === 'refusal') throw refusedError(response.stop_details);
  return { explanation: textOf(response) };
}

module.exports = { getAnthropicClient, draftPost, draftReply, suggestHashtags, classifyMessage, repurposeContent, analyzeCompetitorGaps, summarizeCrisis, explainScenario };
