/**
 * Google Business Profile adapter (Phase 1). Same interface shape as
 * youtube.js (see that file's header for the shared "why" on the
 * connect/publish/fetchMentions/fetchInbox/fetchAnalytics contract).
 *
 * Talks to three separate Google APIs under one OAuth token
 * (business.manage scope):
 *   - mybusinessaccountmanagement / mybusinessbusinessinformation
 *     (v1) — resolve which account+location this connection is for
 *   - mybusiness (v4, the only public endpoint that can create a Local
 *     Post or reply to a review — Google has been tightening API access
 *     to this one over time; if a 403 comes back mentioning API access,
 *     the connected Google Cloud project needs Business Profile API
 *     access requested via https://developers.google.com/my-business/content/prereqs)
 *   - businessprofileperformance (v1) — real daily metrics, not gated
 *     the same way
 *
 * No official Node SDK covers all three cleanly, so this adapter talks
 * to them directly over fetch with a Bearer token, the same way the rest
 * of this repo prefers a plain REST call over an extra SDK dependency
 * when one isn't already pulled in (see how db1.js-db6.js just use the
 * @supabase/supabase-js client directly, no extra abstraction layer).
 *
 * Setup: same GCP OAuth client as youtube.js (GOOGLE_OAUTH_CLIENT_ID/
 * SECRET), with redirect URI {BACKEND_PUBLIC_URL}/api/social/callback/google_business
 * added, and the Business Profile APIs above enabled on that project.
 */

const googleOAuth = require('./_google-oauth');

const PLATFORM = 'google_business';
const SCOPES = ['https://www.googleapis.com/auth/business.manage'];

const ACCOUNT_MGMT_BASE = 'https://mybusinessaccountmanagement.googleapis.com/v1';
const BUSINESS_INFO_BASE = 'https://mybusinessbusinessinformation.googleapis.com/v1';
const MYBUSINESS_V4_BASE = 'https://mybusiness.googleapis.com/v4';
const PERFORMANCE_BASE = 'https://businessprofileperformance.googleapis.com/v1';

function isConfigured() {
  return googleOAuth.isConfigured();
}

async function apiFetch(url, accessToken, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Google Business Profile API ${res.status} on ${url}: ${body.slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

const connect = {
  getAuthUrl(state) {
    return googleOAuth.buildAuthUrl(PLATFORM, SCOPES, state);
  },

  /**
   * Resolves the first account + first location visible to this user so
   * the connected row has a concrete resource name to publish/read
   * against. A business with multiple locations gets only the first one
   * auto-connected in Phase 1 — connecting a second location means
   * running the OAuth flow again (documented limitation, not a bug).
   */
  async exchangeCode(code) {
    const tokens = await googleOAuth.exchangeCode(PLATFORM, code);

    const accounts = await apiFetch(`${ACCOUNT_MGMT_BASE}/accounts`, tokens.accessToken);
    const account = accounts.accounts && accounts.accounts[0];
    if (!account) throw new Error('Google OAuth succeeded but no Business Profile account is associated with this login.');

    const locations = await apiFetch(
      `${BUSINESS_INFO_BASE}/${account.name}/locations?readMask=name,title`,
      tokens.accessToken
    );
    const location = locations.locations && locations.locations[0];
    if (!location) throw new Error(`Business Profile account ${account.name} has no locations to connect.`);

    return {
      ...tokens,
      externalAccountId: `${account.name}/${location.name}`, // e.g. "accounts/123/locations/456"
      accountLabel: location.title || account.accountName || account.name
    };
  }
};

/** post: { content, mediaUrls }. mediaUrls is optional for a Local Post. */
async function publish(account, post) {
  if (!post.content) throw new Error('A Google Business Profile Local Post needs text content.');

  const body = {
    languageCode: 'en-US',
    summary: post.content,
    topicType: 'STANDARD'
  };
  if (post.mediaUrls && post.mediaUrls.length > 0) {
    body.media = post.mediaUrls.map(url => ({ mediaFormat: 'PHOTO', sourceUrl: url }));
  }

  const data = await apiFetch(
    `${MYBUSINESS_V4_BASE}/${account.externalAccountId}/localPosts`,
    account.accessToken,
    { method: 'POST', body: JSON.stringify(body) }
  );
  return { externalPostId: data.name, url: data.searchUrl || null };
}

/** "Mentions" = new customer reviews on the connected location. */
async function fetchMentions(account) {
  const data = await apiFetch(`${MYBUSINESS_V4_BASE}/${account.externalAccountId}/reviews`, account.accessToken);
  return (data.reviews || []).map(review => ({
    externalId: review.reviewId,
    author: review.reviewer && review.reviewer.displayName,
    text: review.comment || `${review.starRating} star rating`,
    url: null,
    capturedAt: review.createTime
  }));
}

// Google Business Profile has a customer messaging feature, but it's a
// separate, more heavily gated API (Business Messages) outside Phase 1
// scope — reviews (fetchMentions) are the inbound channel this adapter
// covers for now.
async function fetchInbox() {
  return [];
}

/** Reply to a review (used by the Inbox/Mentions reply action). */
async function sendReply(account, externalId, message) {
  await apiFetch(
    `${MYBUSINESS_V4_BASE}/${account.externalAccountId}/reviews/${externalId}/reply`,
    account.accessToken,
    { method: 'PUT', body: JSON.stringify({ comment: message }) }
  );
  return { externalId };
}

/** Refreshes an expiring access token — called generically by social/accounts.js. */
async function refreshAccessToken(refreshToken) {
  return googleOAuth.refreshAccessToken(PLATFORM, refreshToken);
}

async function fetchAnalytics(account) {
  const locationPart = account.externalAccountId.split('/').slice(-2).join('/'); // "locations/456"
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  const dateRange = (d) => `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;

  const metrics = ['BUSINESS_IMPRESSIONS_DESKTOP_MAPS', 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH', 'CALL_CLICKS'];
  const params = new URLSearchParams();
  metrics.forEach(m => params.append('dailyMetrics', m));
  params.set('dailyRange.start_date.year', String(start.getUTCFullYear()));
  params.set('dailyRange.start_date.month', String(start.getUTCMonth() + 1));
  params.set('dailyRange.start_date.day', String(start.getUTCDate()));
  params.set('dailyRange.end_date.year', String(end.getUTCFullYear()));
  params.set('dailyRange.end_date.month', String(end.getUTCMonth() + 1));
  params.set('dailyRange.end_date.day', String(end.getUTCDate()));

  const data = await apiFetch(
    `${PERFORMANCE_BASE}/${locationPart}:fetchMultiDailyMetricsTimeSeries?${params.toString()}`,
    account.accessToken
  );

  const out = [];
  for (const series of data.multiDailyMetricTimeSeries || []) {
    for (const entry of series.dailyMetricTimeSeries || []) {
      const metric = entry.dailyMetric;
      for (const dp of (entry.timeSeries && entry.timeSeries.datedValues) || []) {
        out.push({
          metric: metric.toLowerCase(),
          value: Number(dp.value || 0),
          capturedDate: `${dp.date.year}-${String(dp.date.month).padStart(2, '0')}-${String(dp.date.day).padStart(2, '0')}`
        });
      }
    }
  }
  return out;
}

module.exports = {
  isConfigured,
  connect,
  publish,
  fetchMentions,
  fetchInbox,
  sendReply,
  fetchAnalytics,
  refreshAccessToken,
  metadata: {
    name: 'Google Business Profile',
    platform: PLATFORM,
    description: 'Local Post publishing, review monitoring/replies, and Business Profile Performance metrics.'
  }
};
