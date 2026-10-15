/**
 * Pure helpers for the Competitor Opportunity Radar — no DB, no
 * network. social/pollers.js's sweep and routes/competitors.js both use
 * these so the "average engagement rate" definition can't drift between
 * where it's computed and where it's compared.
 */

/**
 * Average per-post engagement rate across a set of posts, normalized
 * by audience size — the same "rate, not raw count" principle
 * lib/experimentStats.js's header explains, applied here so comparing
 * a 500-follower account against a 500,000-follower one is apples to
 * apples. Returns 0 for no posts or zero followers, never NaN/Infinity.
 */
function averageEngagementRate(posts, followersCount) {
  if (!posts || posts.length === 0 || !followersCount) return 0;
  const total = posts.reduce((sum, p) => sum + (Number(p.likes) || 0) + (Number(p.comments) || 0), 0);
  return total / posts.length / followersCount;
}

/**
 * How many of `posts` fall within the last `windowDays` — "posting
 * frequency," computed from each post's own createdTime, not assumed
 * from how many were simply returned by the API (which may return
 * fewer than requested for a quiet account, or posts older than the
 * window for one that happened to have exactly that many total ever).
 */
function postsInWindow(posts, windowDays, now = new Date()) {
  const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  return (posts || []).filter((p) => p.createdTime && new Date(p.createdTime).getTime() >= cutoff).length;
}

module.exports = { averageEngagementRate, postsInWindow };
