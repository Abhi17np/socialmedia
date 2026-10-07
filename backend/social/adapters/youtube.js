/**
 * YouTube adapter (Phase 1). Same "same four/five functions" interface
 * every social adapter exports, mirrored after how db1.js-db6.js export
 * plain async functions server.js wires into routes without branching on
 * which tool it's talking to — here it's routes/social.js and
 * social/scheduler.js that stay platform-agnostic by only ever calling
 * through this shape.
 *
 * "publish" maps to a real video upload (videos.insert) — the YouTube
 * Data API has no public endpoint for Community posts (text-only posts),
 * so a scheduled post targeting YouTube must include a video file in
 * media_urls or it's rejected up front rather than silently doing
 * nothing.
 *
 * Setup:
 *   1. Create a GCP OAuth 2.0 Client (Web application), enable the
 *      "YouTube Data API v3", add redirect URI
 *      {BACKEND_PUBLIC_URL}/api/social/callback/youtube.
 *   2. Set GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET in .env
 *      (shared with google-business.js — same GCP project).
 *   3. Set SOCIAL_TOKEN_ENCRYPTION_KEY (see social/crypto.js) before
 *      connecting any account — tokens are never stored in plaintext.
 */

const { google } = require('googleapis');
const googleOAuth = require('./_google-oauth');

const PLATFORM = 'youtube';
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.force-ssl'
];

function isConfigured() {
  return googleOAuth.isConfigured();
}

/** Builds an authenticated googleapis client from a decrypted account row. */
function getYoutubeClient(account) {
  const auth = googleOAuth.getOAuthClient(PLATFORM);
  auth.setCredentials({ access_token: account.accessToken, refresh_token: account.refreshToken });
  return google.youtube({ version: 'v3', auth });
}

const connect = {
  getAuthUrl(state) {
    return googleOAuth.buildAuthUrl(PLATFORM, SCOPES, state);
  },

  /**
   * Exchanges the OAuth code, then resolves the authorizing user's own
   * channel (mine: true) so the account row has a real externalAccountId
   * and a human-readable label instead of just raw tokens.
   */
  async exchangeCode(code) {
    const tokens = await googleOAuth.exchangeCode(PLATFORM, code);
    const auth = googleOAuth.getOAuthClient(PLATFORM);
    auth.setCredentials({ access_token: tokens.accessToken, refresh_token: tokens.refreshToken });
    const youtube = google.youtube({ version: 'v3', auth });

    const { data } = await youtube.channels.list({ part: ['snippet'], mine: true });
    const channel = data.items && data.items[0];
    if (!channel) throw new Error('Google OAuth succeeded but no YouTube channel is associated with this account.');

    return {
      ...tokens,
      externalAccountId: channel.id,
      accountLabel: channel.snippet.title
    };
  }
};

/**
 * post: { content, mediaUrls }. mediaUrls[0] must be a reachable URL to
 * the video file to upload — the API takes bytes, not a URL reference, so
 * this fetches it and streams it straight into videos.insert.
 */
async function publish(account, post) {
  if (!post.mediaUrls || post.mediaUrls.length === 0) {
    throw new Error('YouTube has no public API for text-only Community posts — attach a video file to publish here.');
  }

  const youtube = getYoutubeClient(account);
  const videoResponse = await fetch(post.mediaUrls[0]);
  if (!videoResponse.ok || !videoResponse.body) {
    throw new Error(`Could not fetch media at ${post.mediaUrls[0]} (${videoResponse.status})`);
  }

  const title = (post.content || 'Untitled').slice(0, 100);
  const { data } = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: { title, description: post.content || '' },
      status: { privacyStatus: 'public' }
    },
    media: { body: videoResponse.body }
  });

  return { externalPostId: data.id, url: `https://youtube.com/watch?v=${data.id}` };
}

/**
 * "Mentions" here = comments across every video on the connected
 * channel — allThreadsRelatedToChannelId is a real YouTube Data API
 * param built for exactly this (channel-wide comment feed, not per-video).
 */
async function fetchMentions(account) {
  const youtube = getYoutubeClient(account);
  const { data } = await youtube.commentThreads.list({
    part: ['snippet'],
    allThreadsRelatedToChannelId: account.externalAccountId,
    maxResults: 50,
    order: 'time'
  });

  return (data.items || []).map(item => {
    const top = item.snippet.topLevelComment.snippet;
    return {
      externalId: item.snippet.topLevelComment.id,
      author: top.authorDisplayName,
      text: top.textDisplay,
      url: top.videoId ? `https://youtube.com/watch?v=${top.videoId}&lc=${item.snippet.topLevelComment.id}` : null,
      capturedAt: top.publishedAt
    };
  });
}

// YouTube has no DM/inbox API — comments (fetchMentions) are the only
// inbound channel available. Return empty rather than guessing.
async function fetchInbox() {
  return [];
}

/** Reply to a YouTube comment (used by the Inbox/Mentions reply action). */
async function sendReply(account, externalId, message) {
  const youtube = getYoutubeClient(account);
  const { data } = await youtube.comments.insert({
    part: ['snippet'],
    requestBody: { snippet: { parentId: externalId, textOriginal: message } }
  });
  return { externalId: data.id };
}

/** Channel-level stats — real numbers, no YouTube Analytics API scope needed. */
/** Refreshes an expiring access token — called generically by social/accounts.js. */
async function refreshAccessToken(refreshToken) {
  return googleOAuth.refreshAccessToken(PLATFORM, refreshToken);
}

async function fetchAnalytics(account) {
  const youtube = getYoutubeClient(account);
  const { data } = await youtube.channels.list({ part: ['statistics'], id: [account.externalAccountId] });
  const stats = data.items && data.items[0] && data.items[0].statistics;
  if (!stats) throw new Error('Could not fetch channel statistics.');

  const capturedDate = new Date().toISOString().slice(0, 10);
  return [
    { metric: 'followers', value: Number(stats.subscriberCount || 0), capturedDate },
    { metric: 'views', value: Number(stats.viewCount || 0), capturedDate },
    { metric: 'video_count', value: Number(stats.videoCount || 0), capturedDate }
  ];
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
    name: 'YouTube',
    platform: PLATFORM,
    description: 'Channel video publishing, channel-wide comments, and channel stats via the YouTube Data API v3.'
  }
};
