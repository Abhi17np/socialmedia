/**
 * LinkedIn adapter (Phase 3). Same connect/publish/fetchMentions/
 * fetchInbox/sendReply/fetchAnalytics contract as every other adapter —
 * see youtube.js's header for the shared "why" on that shape.
 *
 * Posts to the connecting member's own personal profile via two
 * self-serve LinkedIn Developer Portal products that are instant/
 * auto-approved (no manual review queue, unlike Meta's
 * pages_manage_posts — see _meta-oauth.js):
 *   - "Sign In with LinkedIn using OpenID Connect" (openid profile email)
 *     for identity — the id_token's `sub` claim is the member URN id,
 *     used directly as the post author, no extra profile-fetch round trip.
 *   - "Share on LinkedIn" (w_member_social) for posting.
 *
 * Posting to a Company Page instead of a personal profile needs
 * w_organization_social under LinkedIn's Community Management API, which
 * — like Meta's Page permissions — is gated behind a manual LinkedIn
 * partner application. That's out of scope here until that approval
 * clears; this adapter only ever posts as the connected member.
 *
 * LinkedIn has no public, self-serve API for reading comments on a
 * member's own posts or member-to-member messages either (both also sit
 * behind Community Management API), so fetchMentions/fetchInbox/sendReply
 * are stubs, not a gap in this adapter — there's nothing to call yet.
 *
 * Setup:
 *   1. Create an app at https://www.linkedin.com/developers/apps, add the
 *      "Sign In with LinkedIn using OpenID Connect" and "Share on
 *      LinkedIn" products (Products tab — both self-serve, instant).
 *   2. Under Auth settings, add redirect URL
 *      {BACKEND_PUBLIC_URL}/api/social/callback/linkedin.
 *   3. Set LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET in backend/.env.
 */

const AUTH_BASE = 'https://www.linkedin.com/oauth/v2';
const API_BASE = 'https://api.linkedin.com/rest';
// LinkedIn-Version header, YYYYMM. LinkedIn ships a new version monthly and
// only keeps roughly the last 12 months active — a stale value here fails
// every call with "Requested version ... is not active", not a config
// problem on our end. Bump this periodically; check the current window at
// https://learn.microsoft.com/en-us/linkedin/marketing/versioning if calls
// start failing with that error again.
const LINKEDIN_API_VERSION = '202608';

const PLATFORM = 'linkedin';
const SCOPES = ['openid', 'profile', 'email', 'w_member_social'];

function redirectUri() {
  const base = process.env.BACKEND_PUBLIC_URL || 'http://localhost:5000';
  return `${base}/api/social/callback/${PLATFORM}`;
}

function isConfigured() {
  return !!(process.env.LINKEDIN_CLIENT_ID && process.env.LINKEDIN_CLIENT_SECRET);
}

function requireConfigured() {
  if (!isConfigured()) throw new Error('LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET are not set in backend/.env.');
}

/** Decodes the id_token's payload segment — signature verification isn't needed here since it came straight from LinkedIn over TLS in the token response, not from the client. */
function decodeIdToken(idToken) {
  return JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
}

const connect = {
  getAuthUrl(state) {
    requireConfigured();
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: process.env.LINKEDIN_CLIENT_ID,
      redirect_uri: redirectUri(),
      state,
      scope: SCOPES.join(' ')
    });
    return `${AUTH_BASE}/authorization?${params.toString()}`;
  },

  async exchangeCode(code) {
    requireConfigured();
    const res = await fetch(`${AUTH_BASE}/accessToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri(),
        client_id: process.env.LINKEDIN_CLIENT_ID,
        client_secret: process.env.LINKEDIN_CLIENT_SECRET
      }).toString()
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`LinkedIn token exchange failed: ${body.error_description || body.error || res.status}`);

    const claims = decodeIdToken(body.id_token);

    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token || null, // only issued if your app is approved for refresh tokens — see refreshAccessToken() below
      expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000).toISOString() : null,
      externalAccountId: claims.sub,
      accountLabel: claims.name || claims.email || 'LinkedIn member'
    };
  }
};

async function apiFetch(path, account, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${account.accessToken}`,
      'LinkedIn-Version': LINKEDIN_API_VERSION,
      'X-Restli-Protocol-Version': '2.0.0',
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const body = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`LinkedIn API error on ${path}: ${body.message || res.status}`);
  return body;
}

/** Registers + uploads an image to LinkedIn's Images API, returning the image urn a post's content.media.id needs — LinkedIn takes uploaded bytes, not a linked URL, unlike Facebook's /photos endpoint. */
async function uploadImage(account, imageUrl) {
  const register = await apiFetch('/images?action=initializeUpload', account, {
    method: 'POST',
    body: JSON.stringify({ initializeUploadRequest: { owner: `urn:li:person:${account.externalAccountId}` } })
  });
  const { uploadUrl, image } = register.value;

  const imageRes = await fetch(imageUrl);
  if (!imageRes.ok || !imageRes.body) throw new Error(`Could not fetch media at ${imageUrl} (${imageRes.status})`);
  const bytes = Buffer.from(await imageRes.arrayBuffer());

  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${account.accessToken}` },
    body: bytes
  });
  if (!uploadRes.ok) throw new Error(`LinkedIn image upload failed (${uploadRes.status})`);

  return image;
}

/** post: { content, mediaUrls }. Text post to the member's own feed, or a single-image post if mediaUrls is set. */
async function publish(account, post) {
  if (!post.content) throw new Error('A LinkedIn post needs text content.');
  const author = `urn:li:person:${account.externalAccountId}`;

  const body = {
    author,
    commentary: post.content,
    visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: 'PUBLISHED'
  };
  if (post.mediaUrls && post.mediaUrls.length > 0) {
    body.content = { media: { id: await uploadImage(account, post.mediaUrls[0]) } };
  }

  const res = await fetch(`${API_BASE}/posts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${account.accessToken}`,
      'LinkedIn-Version': LINKEDIN_API_VERSION,
      'X-Restli-Protocol-Version': '2.0.0',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(`LinkedIn post failed: ${errBody.message || res.status}`);
  }

  // The Posts API returns the new post's id as a response header, not in
  // the (empty, 201) body.
  const postId = res.headers.get('x-restli-id');
  return { externalPostId: postId, url: postId ? `https://www.linkedin.com/feed/update/${postId}` : null };
}

// No self-serve API for comments on a member's own posts — see header note.
async function fetchMentions() {
  return [];
}

// No self-serve API for LinkedIn messaging — see header note.
async function fetchInbox() {
  return [];
}

async function sendReply() {
  throw new Error('LinkedIn replies require Community Management API access, which this app does not have.');
}

// Member-level post/profile analytics also sit behind Community
// Management API (r_organization_social) — nothing self-serve to report.
async function fetchAnalytics() {
  return [];
}

/**
 * LinkedIn only issues a refresh_token to apps approved for
 * refresh-token-eligible products; otherwise the 60-day access token has
 * no refresh path and an expired connection needs a fresh OAuth connect.
 * Mirrors Meta's shape (facebook.js) in that a fresh refresh_token may
 * come back and must be persisted — social/accounts.js already handles
 * that generically.
 */
async function refreshAccessToken(refreshToken) {
  requireConfigured();
  const res = await fetch(`${AUTH_BASE}/accessToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: process.env.LINKEDIN_CLIENT_ID,
      client_secret: process.env.LINKEDIN_CLIENT_SECRET
    }).toString()
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`LinkedIn token refresh failed: ${body.error_description || body.error || res.status}`);
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || undefined,
    expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000).toISOString() : null
  };
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
    name: 'LinkedIn',
    platform: PLATFORM,
    description: 'Personal-profile text/image post publishing via the LinkedIn Posts API. Company Page posting and comment/DM access need LinkedIn Community Management API approval, not available yet.'
  }
};
