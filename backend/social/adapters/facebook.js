/**
 * Facebook adapter (Phase 2). Same interface shape as youtube.js/
 * google-business.js — see youtube.js's header for the shared "why" on
 * the connect/publish/fetchMentions/fetchInbox/fetchAnalytics/sendReply
 * contract every adapter exports so routes/social.js, queue.js and
 * pollers.js never branch on platform name.
 *
 * Talks to a connected Facebook Page (not a personal profile — the
 * Graph API has no public posting endpoint for personal profiles).
 * See _meta-oauth.js for the token lifecycle (short-lived code ->
 * long-lived user token -> Page token) and the Meta App Review note on
 * pages_manage_posts.
 *
 * Also covers Lead Ads capture (fetchLeads) — Instant Form leads are a
 * Page-owned asset (leadgen_forms) regardless of whether the campaign
 * actually ran on Facebook or Instagram placements, so this one method
 * captures both; there's no separate Instagram leads edge. Requires the
 * `leads_retrieval` permission below AND the connected Page to have
 * accepted Meta's Lead Ads Terms of Service (Page Settings > Lead Access
 * — a one-time per-Page acceptance Meta requires before ANY app, including
 * ones in Development Mode, can read that Page's leads via API).
 *
 * Setup: create a Meta App at developers.facebook.com, add the
 * "Facebook Login for Business" product, set redirect URI
 * {BACKEND_PUBLIC_URL}/api/social/callback/facebook, and set
 * META_APP_ID/META_APP_SECRET in .env (shared with instagram.js).
 */

const metaOAuth = require('./_meta-oauth');

const PLATFORM = 'facebook';
// All 6 now show "Ready for testing" (Standard Access) on the Meta App
// dashboard's "Manage everything on your Page" use case: pages_show_list,
// pages_read_engagement, leads_retrieval, pages_manage_ads,
// pages_manage_posts (publish), and now read_insights (Page Insights) +
// pages_messaging (Messenger inbox) too. If reconnecting still hits
// "Invalid Scopes", that error names the exact offending scope(s) —
// pull just those back out rather than reverting this whole list.
const SCOPES = ['pages_show_list', 'pages_read_engagement', 'leads_retrieval', 'pages_manage_ads', 'pages_manage_posts', 'read_insights', 'pages_messaging'];

function isConfigured() {
  return metaOAuth.isConfigured();
}

const connect = {
  getAuthUrl(state) {
    return metaOAuth.buildAuthUrl(PLATFORM, SCOPES, state);
  },

  /**
   * A person can manage multiple Pages — Phase 2 auto-connects the first
   * one returned by /me/accounts, same documented "first one, run OAuth
   * again for another" limitation as google-business.js's location pick.
   */
  async exchangeCode(code) {
    const { userAccessToken, expiresAt } = await metaOAuth.exchangeCodeForLongLivedUserToken(PLATFORM, code);
    const pages = await metaOAuth.listPages(userAccessToken);
    const page = pages[0];
    if (!page) {
      const detail = await metaOAuth.explainNoPages(userAccessToken, SCOPES);
      throw new Error(`Facebook OAuth succeeded but this user manages no Pages to connect. ${detail}`);
    }

    return {
      accessToken: page.access_token,      // Page token — used for all Graph calls below
      refreshToken: userAccessToken,        // the long-lived USER token — needed to re-derive a Page token on refresh
      expiresAt,
      externalAccountId: page.id,
      accountLabel: page.name
    };
  }
};

/**
 * Re-derives a fresh Page token from a re-exchanged long-lived user
 * token. Needs the Page id, so accounts.js passes the full account as a
 * second argument (youtube.js/google-business.js ignore it).
 */
async function refreshAccessToken(refreshToken, account) {
  const { userAccessToken, expiresAt } = await metaOAuth.refreshLongLivedUserToken(refreshToken);
  const pages = await metaOAuth.listPages(userAccessToken);
  const page = pages.find(p => p.id === account.externalAccountId);
  if (!page) throw new Error(`Page ${account.externalAccountId} is no longer manageable by this Meta user.`);
  return { accessToken: page.access_token, refreshToken: userAccessToken, expiresAt };
}

/** post: { content, mediaUrls }. A single photo, or a text-only feed post. */
async function publish(account, post) {
  if (post.mediaUrls && post.mediaUrls.length > 0) {
    const data = await metaOAuth.graphPost(`/${account.externalAccountId}/photos`, {
      url: post.mediaUrls[0],
      caption: post.content || '',
      access_token: account.accessToken
    });
    return { externalPostId: data.post_id || data.id, url: null };
  }

  if (!post.content) throw new Error('A Facebook post needs text content or a media URL.');
  const data = await metaOAuth.graphPost(`/${account.externalAccountId}/feed`, {
    message: post.content,
    access_token: account.accessToken
  });
  return { externalPostId: data.id, url: `https://facebook.com/${data.id}` };
}

/** "Mentions" = comments on the Page's own recent posts. */
async function fetchMentions(account) {
  const data = await metaOAuth.graphFetch(`/${account.externalAccountId}/feed`, {
    fields: 'comments{id,message,from,created_time,permalink_url}',
    access_token: account.accessToken
  });

  const comments = [];
  for (const post of data.data || []) {
    for (const c of (post.comments && post.comments.data) || []) {
      comments.push({
        externalId: c.id,
        author: c.from && c.from.name,
        text: c.message,
        url: c.permalink_url || null,
        capturedAt: c.created_time
      });
    }
  }
  return comments;
}

/** Messenger conversations for this Page. */
async function fetchInbox(account) {
  const data = await metaOAuth.graphFetch(`/${account.externalAccountId}/conversations`, {
    fields: 'id,snippet,updated_time,participants',
    access_token: account.accessToken
  });

  return (data.data || []).map(conv => ({
    externalThreadId: conv.id,
    sender: (conv.participants && conv.participants.data && conv.participants.data.map(p => p.name).join(', ')) || null,
    message: conv.snippet,
    receivedAt: conv.updated_time
  }));
}

/**
 * Replies to either a comment (mentions) or a Messenger conversation
 * (inbox) — externalId here is inbox_messages.external_thread_id, which
 * for a comment reply is the comment id and for Messenger is the
 * conversation id. The Send API needs a recipient id for Messenger, not
 * just the conversation id, so a Messenger reply additionally looks the
 * participant up first.
 */
async function sendReply(account, externalId, message) {
  if (externalId.includes('_')) {
    // Graph comment ids contain an underscore (postId_commentId); reply
    // as a nested comment.
    const data = await metaOAuth.graphPost(`/${externalId}/comments`, { message, access_token: account.accessToken });
    return { externalId: data.id };
  }

  const conv = await metaOAuth.graphFetch(`/${externalId}`, { fields: 'participants', access_token: account.accessToken });
  const recipient = (conv.participants && conv.participants.data || []).find(p => p.id !== account.externalAccountId);
  if (!recipient) throw new Error(`Could not resolve a Messenger recipient for conversation ${externalId}.`);

  const data = await metaOAuth.graphPost('/me/messages', {
    recipient: JSON.stringify({ id: recipient.id }),
    message: JSON.stringify({ text: message }),
    access_token: account.accessToken
  });
  return { externalId: data.message_id };
}

async function fetchAnalytics(account) {
  const data = await metaOAuth.graphFetch(`/${account.externalAccountId}/insights`, {
    metric: 'page_impressions,page_fans,page_engaged_users',
    period: 'day',
    access_token: account.accessToken
  });

  const out = [];
  for (const series of data.data || []) {
    const metric = series.name.replace('page_', '');
    for (const point of series.values || []) {
      out.push({ metric, value: Number(point.value || 0), capturedDate: point.end_time.slice(0, 10) });
    }
  }
  return out;
}

// Field names Meta's Instant Form leads commonly use for the three
// concept columns this app surfaces directly (full_name/email/phone) —
// forms are user-authored with arbitrary custom questions too, which
// stay in each lead's fieldData verbatim for anything this map misses.
const NAME_FIELDS = ['full_name', 'first_name'];
const EMAIL_FIELDS = ['email', 'work_email'];
const PHONE_FIELDS = ['phone_number', 'phone'];

// Case-insensitive: whoever built a given Lead Ads form keys its custom
// questions with whatever casing they typed (confirmed by real leads
// coming back with FULL_NAME/PHONE/EMAIL on one form vs full_name/
// phone_number/email on another) — matching case-sensitively silently
// dropped a real, captured answer to null on any form using the
// "wrong" case, showing as an empty name/email/phone in the UI even
// though the raw answer was there in fieldData all along.
function pickLeadField(fieldData, names) {
  for (const name of names) {
    const field = fieldData.find(f => f.name && f.name.toLowerCase() === name.toLowerCase());
    if (field && field.values && field.values[0]) return field.values[0];
  }
  return null;
}

/**
 * Every Instant Form lead across every leadgen form on this Page — see
 * this file's header on why one Page-scoped call covers leads from both
 * Facebook and Instagram ad placements. Not paginated: each poll (see
 * backend/leads/poller.js) only cares about leads new since the last
 * sweep, and dedup happens there by leadgen_id, so a form accumulating
 * more leads than one page returns just means older leads are picked up
 * on a later sweep rather than missed.
 */
async function fetchLeads(account) {
  const forms = await metaOAuth.graphFetch(`/${account.externalAccountId}/leadgen_forms`, {
    fields: 'id,name',
    access_token: account.accessToken
  });

  const leads = [];
  for (const form of forms.data || []) {
    const data = await metaOAuth.graphFetch(`/${form.id}/leads`, {
      fields: 'id,created_time,field_data,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name',
      access_token: account.accessToken
    });

    for (const lead of data.data || []) {
      const fieldData = lead.field_data || [];
      leads.push({
        externalId: lead.id,
        formId: form.id,
        formName: form.name,
        campaignId: lead.campaign_id || null,
        campaignName: lead.campaign_name || null,
        adsetId: lead.adset_id || null,
        adId: lead.ad_id || null,
        adName: lead.ad_name || null,
        fullName: pickLeadField(fieldData, NAME_FIELDS),
        email: pickLeadField(fieldData, EMAIL_FIELDS),
        phone: pickLeadField(fieldData, PHONE_FIELDS),
        fieldData,
        createdTime: lead.created_time
      });
    }
  }
  return leads;
}

/**
 * Count of the Page's own posts published since `sinceISO` — read
 * straight from the Page's /posts edge rather than this app's own
 * scheduled_posts table, so the Brand Health summary's "posts" column
 * reflects everything actually posted on the Page (including posts made
 * directly on Facebook, not just ones scheduled through this dashboard).
 * Needs only pages_read_engagement, already granted.
 */
async function fetchPostCount(account, sinceISO) {
  const sinceUnix = Math.floor(new Date(sinceISO).getTime() / 1000);
  const posts = await metaOAuth.graphFetchAll(`/${account.externalAccountId}/posts`, {
    since: String(sinceUnix),
    fields: 'id',
    access_token: account.accessToken
  });
  return posts.length;
}

const BASIC_POST_FIELDS = 'id,message,created_time,permalink_url';
const ENGAGEMENT_POST_FIELDS = `${BASIC_POST_FIELDS},likes.summary(true).limit(0),comments.summary(true).limit(0),shares`;

function normalizePost(p) {
  return {
    externalPostId: p.id,
    message: p.message || null,
    permalinkUrl: p.permalink_url || null,
    createdTime: p.created_time,
    likes: p.likes ? ((p.likes.summary && p.likes.summary.total_count) || 0) : null,
    comments: p.comments ? ((p.comments.summary && p.comments.summary.total_count) || 0) : null,
    shares: p.shares ? (p.shares.count || 0) : null
  };
}

/**
 * Recent Page posts with their per-post engagement (likes/comments/shares)
 * — what a "how did that post do" view needs that fetchPostCount (a bare
 * count) and fetchAnalytics (Page-level daily totals) don't cover.
 * summary(true).limit(0) on the likes/comments edges asks Graph API for
 * just the total_count, not every individual like/comment.
 *
 * The likes/comments/shares edges need a permission tier
 * (pages_read_engagement Advanced Access, or the "Page Public Content
 * Access" feature) that plain post listing doesn't — confirmed by
 * fetchPostCount (fields: 'id' only) working fine on accounts where this
 * fails. Rather than losing the whole post list over those 3 gated
 * fields, retry with just the basic fields and report engagement counts
 * as unavailable (null) instead of erroring the whole call out.
 */
async function fetchPosts(account, limit = 10) {
  try {
    const data = await metaOAuth.graphFetch(`/${account.externalAccountId}/posts`, {
      fields: ENGAGEMENT_POST_FIELDS,
      limit: String(limit),
      access_token: account.accessToken
    });
    return (data.data || []).map(normalizePost);
  } catch (err) {
    if (!err.isPermanentAuthError) throw err;
    const data = await metaOAuth.graphFetch(`/${account.externalAccountId}/posts`, {
      fields: BASIC_POST_FIELDS,
      limit: String(limit),
      access_token: account.accessToken
    });
    return (data.data || []).map(normalizePost);
  }
}

/**
 * Enriches a permanent auth error (see _meta-oauth.js's graphError) with
 * *why* the permission is missing before it reaches pollers.js/routes —
 * "reconnect this account" vs "this needs App Review on Meta's dashboard"
 * are different fixes, and the bare Graph error can't tell them apart.
 */
function withAuthDiagnostic(fn) {
  return async function (account, ...args) {
    try {
      return await fn(account, ...args);
    } catch (err) {
      if (err.isPermanentAuthError && account.refreshToken) {
        const detail = await metaOAuth.explainPermissionError(account.refreshToken, account.externalAccountId, err.missingScope || 'pages_read_engagement');
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
  fetchLeads,
  fetchPostCount: withAuthDiagnostic(fetchPostCount),
  fetchPosts: withAuthDiagnostic(fetchPosts),
  refreshAccessToken,
  metadata: {
    name: 'Facebook',
    platform: PLATFORM,
    description: 'Page post publishing, comment monitoring/replies, Messenger inbox, Page Insights, and Lead Ads capture via the Graph API.'
  }
};
