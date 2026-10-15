/**
 * Shared metric-name constants that more than one module needs — split
 * out of routes/social.js (which defined this inline for its own
 * analytics summary) so lib/experimentSweep.js can use the exact same
 * mapping for its audience-size denominator, rather than maintaining a
 * second copy that could silently drift from the first.
 */

// Which analytics_snapshots metric name holds "how many followers/fans
// does this account have" per platform — see each adapter's
// fetchAnalytics() for where these names come from. Deliberately only
// the 3 platforms that report one; linkedin/google_business/whatsapp
// have no follower-count metric collected today (see those adapters'
// own fetchAnalytics headers).
const FOLLOWER_METRIC = { youtube: 'followers', facebook: 'fans', instagram: 'follower_count' };

module.exports = { FOLLOWER_METRIC };
