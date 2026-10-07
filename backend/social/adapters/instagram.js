/**
 * Instagram adapter (Phase 2). Same interface shape as facebook.js (see
 * that file's header, and youtube.js's for the shared "why" on the
 * contract) — Instagram publishing/reading always goes through the
 * Facebook Page it's linked to, using that Page's access token, not a
 * separate Instagram OAuth (see _meta-oauth.js).
 *
 * "publish" maps to the Content Publishing API's two-step flow (create
 * a media container, then publish it) — Instagram has no text-only
 * post, same constraint as YouTube: media_urls is required.
 *
 * Setup: same Meta App as facebook.js (META_APP_ID/SECRET), redirect URI
 * {BACKEND_PUBLIC_URL}/api/social/callback/instagram added, and the
 * connected Page must have an Instagram Business (or Creator) account
 * linked to it in Meta Business Suite — Instagram Graph API access only
 * exists for accounts of that type, never a regular personal account.
 * Also needs the `instagram_manage_messages` permission enabled under
 * App Review > Permissions and Features (Standard Access is enough for
 * your own linked Page/Business Portfolio) for fetchInbox()'s DM capture
 * to work — an account connected before that scope existed must
 * reconnect to pick it up.
 */

const metaOAuth = require('./_meta-oauth');

const PLATFORM = 'instagram';
// Instagram publishing/insights ride on the same Page-scoped permissions
// as facebook.js, plus instagram_content_publish and instagram_manage_comments/insights.
// instagram_manage_messages is what fetchInbox() below needs for DM capture —
// an account connected before this was added must reconnect to pick it up.
const SCOPES = [
  'pages_show_list', 'pages_read_engagement',
  'instagram_basic', 'instagram_content_publish', 'instagram_manage_comments', 'instagram_manage_insights',
  // Both scopes are needed together on the same token for fetchInbox()'s
  // platform=instagram call against /{page-id}/conversations — confirmed
  // by that call returning an empty list (not a permission error) with
  // only instagram_manage_messages granted; facebook.js's own working
  // Messenger fetchInbox proves pages_messaging is what that endpoint
  // actually checks.
  'instagram_manage_messages', 'pages_messaging'
];

function isConfigured() {
  return metaOAuth.isConfigured();
}

const connect = {
  getAuthUrl(state) {
    return metaOAuth.buildAuthUrl(PLATFORM, SCOPES, state);
  },

  /**
   * Same "first eligible Page" auto-pick as facebook.js, but only
   * considers Pages that actually have an Instagram Business Account
   * linked — a Page without one can't be used here at all.
   */
  async exchangeCode(code) {
    const { userAccessToken, expiresAt } = await metaOAuth.exchangeCodeForLongLivedUserToken(PLATFORM, code);
    const pages = await metaOAuth.listPages(userAccessToken);
    const page = pages.find(p => p.instagram_business_account && p.instagram_business_account.id);
    if (!page) {
      if (pages.length === 0) {
        const detail = await metaOAuth.explainNoPages(userAccessToken, SCOPES);
        throw new Error(`Facebook OAuth succeeded but this user manages no Pages to connect. ${detail}`);
      }
      throw new Error('No connected Facebook Page has an Instagram Business/Creator account linked — link one in Meta Business Suite first.');
    }

    return {
      accessToken: page.access_token,
      refreshToken: userAccessToken,
      expiresAt,
      externalAccountId: page.instagram_business_account.id, // the IG user id Graph calls target
      accountLabel: page.name
    };
  }
};

async function refreshAccessToken(refreshToken, account) {
  const { userAccessToken, expiresAt } = await metaOAuth.refreshLongLivedUserToken(refreshToken);
  const pages = await metaOAuth.listPages(userAccessToken);
  const page = pages.find(p => p.instagram_business_account && p.instagram_business_account.id === account.externalAccountId);
  if (!page) throw new Error(`Instagram account ${account.externalAccountId} is no longer manageable by this Meta user.`);
  return { accessToken: page.access_token, refreshToken: userAccessToken, expiresAt };
}

/** post: { content, mediaUrls }. mediaUrls[0] is required — image or video/reel URL. */
async function publish(account, post) {
  if (!post.mediaUrls || post.mediaUrls.length === 0) {
    throw new Error('Instagram has no text-only post — attach an image or video URL to publish here.');
  }

  const isVideo = /\.(mp4|mov)(\?|$)/i.test(post.mediaUrls[0]);
  const container = await metaOAuth.graphPost(`/${account.externalAccountId}/media`, {
    [isVideo ? 'video_url' : 'image_url']: post.mediaUrls[0],
    caption: post.content || '',
    ...(isVideo ? { media_type: 'REELS' } : {}),
    access_token: account.accessToken
  });

  const published = await metaOAuth.graphPost(`/${account.externalAccountId}/media_publish`, {
    creation_id: container.id,
    access_token: account.accessToken
  });

  return { externalPostId: published.id, url: null };
}

/** "Mentions" = comments on the account's own recent media. */
async function fetchMentions(account) {
  const data = await metaOAuth.graphFetch(`/${account.externalAccountId}/media`, {
    fields: 'id,permalink,comments{id,text,username,timestamp}',
    access_token: account.accessToken
  });

  const comments = [];
  for (const media of data.data || []) {
    for (const c of (media.comments && media.comments.data) || []) {
      comments.push({
        externalId: c.id,
        author: c.username,
        text: c.text,
        url: media.permalink || null,
        capturedAt: c.timestamp
      });
    }
  }
  return comments;
}

// Instagram DMs ride on the same unified Page Inbox /conversations edge
// as facebook.js's fetchInbox — just scoped with platform=instagram and
// called against the linked Page's id, not the IG business account id
// (account.externalAccountId here). That Page id isn't stored on the
// social_accounts row (only the IG business account id is), so it's
// re-derived each sweep from the long-lived user token the same way
// refreshAccessToken() above does, instead of adding a migration for one
// extra column.
async function resolvePageId(account) {
  if (!account.refreshToken) throw new Error('Cannot resolve the linked Page without a refresh token — reconnect this Instagram account.');
  const pages = await metaOAuth.listPages(account.refreshToken);
  const page = pages.find(p => p.instagram_business_account && p.instagram_business_account.id === account.externalAccountId);
  if (!page) throw new Error(`Could not find the Facebook Page linked to Instagram account ${account.externalAccountId}.`);
  return page.id;
}

/**
 * Meta's Instagram Conversations API returns an empty list — not a
 * permission error — for a Page the app was never explicitly subscribed
 * to for messaging. The OAuth connect flow never made this call (it's a
 * separate step from granting pages_messaging/instagram_manage_messages),
 * so an already-connected account needs this run once against its Page
 * before fetchInbox can see anything. Idempotent — safe to call every
 * sweep rather than only once at connect time.
 */
async function ensureSubscribedToPage(pageId, accessToken) {
  await metaOAuth.graphPost(`/${pageId}/subscribed_apps`, {
    subscribed_fields: 'messages,messaging_postbacks,message_reactions,message_reads',
    access_token: accessToken
  });
}

async function fetchInbox(account) {
  const pageId = await resolvePageId(account);
  await ensureSubscribedToPage(pageId, account.accessToken);

  // TEMP diagnostic — the /conversations call below has been coming back
  // as `{"data":[]}` with no error, and Meta returns that exact shape for
  // two different situations that otherwise look identical: genuinely no
  // conversations to show yet, OR a requested scope that never actually
  // attached to this token (routine in Development Mode when the
  // connected Facebook account isn't a Developer/Admin/Tester on the
  // app — the OAuth consent screen shows the scope as requested either
  // way). Checking /debug_token's granular_scopes directly (same
  // mechanism explainPermissionError already uses elsewhere in this file)
  // tells them apart: if pageId is missing from either list logged below,
  // that scope needs fixing on Meta's dashboard — reconnecting again
  // won't help until it does.
  if (account.refreshToken) {
    const [messagingPages, igMessagingPages] = await Promise.all([
      metaOAuth.grantedTargetIds(account.refreshToken, 'pages_messaging').catch(() => ['<lookup failed>']),
      metaOAuth.grantedTargetIds(account.refreshToken, 'instagram_manage_messages').catch(() => ['<lookup failed>'])
    ]);
    console.log(`[instagram/fetchInbox] pageId=${pageId} pages_messaging granted for pages=[${messagingPages}] instagram_manage_messages granted for pages=[${igMessagingPages}]`);
  }

  const data = await metaOAuth.graphFetch(`/${pageId}/conversations`, {
    platform: 'instagram',
    fields: 'id,snippet,updated_time,participants',
    access_token: account.accessToken
  });

  // TEMP diagnostic — remove once DM capture is confirmed working.
  console.log(`[instagram/fetchInbox] pageId=${pageId} conversations=${(data.data || []).length}`, JSON.stringify(data));

  return (data.data || []).map(conv => ({
    externalThreadId: conv.id,
    sender: (conv.participants && conv.participants.data && conv.participants.data.map(p => p.username || p.name).join(', ')) || null,
    message: conv.snippet,
    receivedAt: conv.updated_time
  }));
}

/** Reply to a comment (used by the Mentions reply action). */
async function sendReply(account, externalId, message) {
  const data = await metaOAuth.graphPost(`/${externalId}/replies`, { message, access_token: account.accessToken });
  return { externalId: data.id };
}

async function fetchAnalytics(account) {
  const data = await metaOAuth.graphFetch(`/${account.externalAccountId}/insights`, {
    metric: 'reach,profile_views,follower_count',
    period: 'day',
    access_token: account.accessToken
  });

  const out = [];
  for (const series of data.data || []) {
    for (const point of series.values || []) {
      out.push({ metric: series.name, value: Number(point.value || 0), capturedDate: (point.end_time || new Date().toISOString()).slice(0, 10) });
    }
  }
  return out;
}

/**
 * Count of the account's own media published since `sinceISO` — same
 * "read live from the platform, not this app's own scheduled_posts table"
 * reasoning as facebook.js's fetchPostCount. Needs only instagram_basic,
 * already granted.
 */
async function fetchPostCount(account, sinceISO) {
  const sinceUnix = Math.floor(new Date(sinceISO).getTime() / 1000);
  const media = await metaOAuth.graphFetchAll(`/${account.externalAccountId}/media`, {
    since: String(sinceUnix),
    fields: 'id',
    access_token: account.accessToken
  });
  return media.length;
}

const BASIC_MEDIA_FIELDS = 'id,caption,timestamp,permalink';
const ENGAGEMENT_MEDIA_FIELDS = `${BASIC_MEDIA_FIELDS},like_count,comments_count`;

function normalizeMedia(m) {
  return {
    externalPostId: m.id,
    message: m.caption || null,
    permalinkUrl: m.permalink || null,
    createdTime: m.timestamp,
    likes: 'like_count' in m ? (m.like_count || 0) : null,
    comments: 'comments_count' in m ? (m.comments_count || 0) : null,
    shares: null // no shares figure exists for Instagram media via this API
  };
}

/**
 * Recent media with their per-post engagement — same "how did that post
 * do" purpose as facebook.js's fetchPosts, including the same fallback:
 * like_count/comments_count need a permission tier plain media listing
 * doesn't, so a permission error there retries without them rather than
 * losing the whole post list (see facebook.js's fetchPosts for why).
 */
async function fetchPosts(account, limit = 10) {
  try {
    const data = await metaOAuth.graphFetch(`/${account.externalAccountId}/media`, {
      fields: ENGAGEMENT_MEDIA_FIELDS,
      limit: String(limit),
      access_token: account.accessToken
    });
    return (data.data || []).map(normalizeMedia);
  } catch (err) {
    if (!err.isPermanentAuthError) throw err;
    const data = await metaOAuth.graphFetch(`/${account.externalAccountId}/media`, {
      fields: BASIC_MEDIA_FIELDS,
      limit: String(limit),
      access_token: account.accessToken
    });
    return (data.data || []).map(normalizeMedia);
  }
}

// Same idea as facebook.js's withAuthDiagnostic — see that file's comment.
function withAuthDiagnostic(fn) {
  return async function (account, ...args) {
    try {
      return await fn(account, ...args);
    } catch (err) {
      if (err.isPermanentAuthError && account.refreshToken) {
        const detail = await metaOAuth.explainPermissionError(account.refreshToken, account.externalAccountId, err.missingScope || 'instagram_basic');
        if (detail) err.message = `${err.message} — ${detail}`;
      }
      throw err;
    }
  };
}

module.exports = {
  isConfigured,
  connect,
  publish,
  fetchMentions: withAuthDiagnostic(fetchMentions),
  fetchInbox: withAuthDiagnostic(fetchInbox),
  sendReply,
  fetchAnalytics: withAuthDiagnostic(fetchAnalytics),
  fetchPostCount: withAuthDiagnostic(fetchPostCount),
  fetchPosts: withAuthDiagnostic(fetchPosts),
  refreshAccessToken,
  metadata: {
    name: 'Instagram',
    platform: PLATFORM,
    description: 'Media publishing, comment monitoring/replies, DM inbox capture, and account insights via the Instagram Graph API (linked Facebook Page required).'
  }
};
