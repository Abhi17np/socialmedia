/**
 * Pure helpers for the AI Content Repurposing Studio (routes/ai.js's
 * POST /ai/compose/repurpose) — duplicate-content detection and media-
 * requirement checks, kept separate from lib/ai.js (the actual
 * Anthropic call) so both are unit-testable with no network/DB.
 */

/** Lowercases, strips punctuation, splits on whitespace — a deliberately simple normalization, not a real tokenizer. */
function normalizeForComparison(text) {
  return (text || '').toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);
}

/**
 * Token-overlap (Jaccard) similarity, 0..1. Lexical, not semantic — it
 * reliably flags a near-verbatim repost of existing content, but will
 * NOT catch a paraphrase of the same idea in different words. That's
 * the honest, explainable tradeoff of a method with no false sense of
 * "understanding" the text; stated here so it's not mistaken for more
 * than it is.
 */
function jaccardSimilarity(a, b) {
  const setA = new Set(normalizeForComparison(a));
  const setB = new Set(normalizeForComparison(b));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection++;
  const union = setA.size + setB.size - intersection;
  return intersection / union;
}

// High bar deliberately — this flags a near-identical rewrite of
// existing content, not merely "a similar topic," which would flag
// constantly for any brand that posts about the same few themes.
const DUPLICATE_SIMILARITY_THRESHOLD = 0.8;

/**
 * Checks one candidate variant against a tenant's recent posts (caller
 * supplies the list — this stays DB-free). Returns the first match over
 * the threshold, or null. Order of recentPosts determines which match
 * is reported when several are similar; callers pass newest-first so
 * the warning points at the most recent near-duplicate.
 */
function findDuplicateWarning(candidateText, recentPosts) {
  for (const post of recentPosts || []) {
    const similarity = jaccardSimilarity(candidateText, post.content);
    if (similarity >= DUPLICATE_SIMILARITY_THRESHOLD) {
      return { scheduledPostId: post.id, similarity: Math.round(similarity * 100) / 100 };
    }
  }
  return null;
}

// The only per-platform media requirement this app can genuinely verify
// today: social/adapters/youtube.js's publish() throws when a post has
// no mediaUrls ("YouTube has no public API for text-only Community
// posts"). Deliberately not a larger invented list of dimension/
// duration/format constraints this app has no way to actually check —
// an honest "can't verify that" beats a guessed pass/fail.
const REQUIRES_MEDIA = new Set(['youtube']);

function mediaRequirementWarnings(targetPlatforms, hasMedia) {
  if (hasMedia) return [];
  return (targetPlatforms || [])
    .filter((platform) => REQUIRES_MEDIA.has(platform))
    .map((platform) => ({
      platform,
      message: 'YouTube has no public API for text-only posts — attach a video before scheduling this variant.'
    }));
}

module.exports = { normalizeForComparison, jaccardSimilarity, findDuplicateWarning, mediaRequirementWarnings, DUPLICATE_SIMILARITY_THRESHOLD };
