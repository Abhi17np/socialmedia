/**
 * Shared metric-name constants and account-level metric helpers that
 * more than one module needs — split out of routes/social.js (which
 * defined FOLLOWER_METRIC inline for its own analytics summary) so
 * lib/experimentSweep.js, routes/competitors.js, and the Marketing
 * Decision Simulator (lib/decisionSimulator.js) can all use the exact
 * same definitions rather than maintaining copies that could drift.
 */
const { scoped } = require('./query');
const { averageEngagementRate } = require('./competitorRadar');

// Which analytics_snapshots metric name holds "how many followers/fans
// does this account have" per platform — see each adapter's
// fetchAnalytics() for where these names come from. Deliberately only
// the 3 platforms that report one; linkedin/google_business/whatsapp
// have no follower-count metric collected today (see those adapters'
// own fetchAnalytics headers).
const FOLLOWER_METRIC = { youtube: 'followers', facebook: 'fans', instagram: 'follower_count' };

/** The latest known follower/fan count for an account, or 0 if this platform reports none or no snapshot exists yet. */
async function latestFollowerCount(client, accountId, platform) {
  const metric = FOLLOWER_METRIC[platform];
  if (!metric) return 0;
  const { data: row } = await client.from('analytics_snapshots').select('value').eq('social_account_id', accountId)
    .eq('metric', metric).order('captured_date', { ascending: false }).limit(1).maybeSingle();
  return row ? Number(row.value) || 0 : 0;
}

/**
 * This account's own average engagement rate over the last `windowDays`
 * — (likes+comments) summed per post, averaged across posts, divided by
 * the account's latest follower count (see lib/competitorRadar.js's
 * averageEngagementRate for why: the same audience-normalized "rate,
 * not raw count" principle, applied here so this number is directly
 * comparable to a tracked competitor's, or to a scenario baseline).
 * Originally routes/competitors.js's own ownEngagementRate() — moved
 * here once lib/decisionSimulator.js needed the identical calculation,
 * rather than keeping two copies that could drift.
 */
async function computeAccountEngagementRate(client, tenantId, accountId, platform, { windowDays = 30 } = {}) {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const { data: ownPosts } = await scoped(client, tenantId, 'scheduled_posts').select('id').eq('status', 'published').gte('scheduled_at', since).contains('target_account_ids', [accountId]);
  const postIds = (ownPosts || []).map((p) => p.id);

  const followers = await latestFollowerCount(client, accountId, platform);
  if (postIds.length === 0 || !followers) return { rate: 0, postsCompared: 0, followers };

  const { data: analyticsRows } = await client.from('post_analytics').select('scheduled_post_id, metric, value').in('scheduled_post_id', postIds).eq('social_account_id', accountId);
  const byPost = new Map();
  for (const row of analyticsRows || []) {
    if (!['likes', 'comments'].includes(row.metric)) continue;
    const current = byPost.get(row.scheduled_post_id) || { likes: 0, comments: 0 };
    current[row.metric] = Number(row.value) || 0; // post_analytics is itself a time series; this is a reasonable simplification (last-seen per metric, not re-sorted by date here) for a "rough comparator," not a headline analytics number
    byPost.set(row.scheduled_post_id, current);
  }
  const pseudoPosts = [...byPost.values()];
  return { rate: averageEngagementRate(pseudoPosts, followers), postsCompared: pseudoPosts.length, followers };
}

module.exports = { FOLLOWER_METRIC, latestFollowerCount, computeAccountEngagementRate };
