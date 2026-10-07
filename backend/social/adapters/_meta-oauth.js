/**
 * Shared OAuth + Graph API helper for the two Meta-family adapters
 * (facebook.js, instagram.js) — same role as _google-oauth.js for
 * youtube.js/google-business.js: one Meta App (META_APP_ID/SECRET)
 * covers both, since Instagram publishing/reading goes through the same
 * Graph API using the linked Facebook Page's access token, not a
 * separate Instagram-specific OAuth app.
 *
 * Meta has no refresh_token the way Google does. Instead:
 *   1. The OAuth code exchanges for a short-lived user token (~1-2h).
 *   2. That's immediately exchanged for a long-lived user token (~60d).
 *   3. The long-lived user token is used to fetch a Page access token,
 *      which inherits that ~60d validity and is what gets stored as
 *      social_accounts.access_token — Graph API calls for a Page (and
 *      its linked Instagram Business Account) use the Page token
 *      directly, not the user token.
 * "Refreshing" here means re-running step 2 on the still-valid long-lived
 * user token before it expires, then re-deriving a fresh Page token —
 * see refreshAccessToken() in facebook.js/instagram.js. If the user
 * token has already fully expired, this fails and the account needs a
 * fresh OAuth connect (same as any platform whose refresh window is
 * missed entirely).
 *
 * Meta App Review note (build spec section 6, Phase 2): pages_manage_posts
 * and instagram_content_publish require App Review before they work for
 * anyone other than the app's own Meta developer/testers in Development
 * Mode. This code is written and worth testing against your own
 * dev-mode Page/Instagram Business Account now; it won't work for real
 * third-party users until that review is approved.
 */

const GRAPH_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

function redirectUriFor(platform) {
  const base = process.env.BACKEND_PUBLIC_URL || 'http://localhost:5000';
  return `${base}/api/social/callback/${platform}`;
}

function isConfigured() {
  return !!(process.env.META_APP_ID && process.env.META_APP_SECRET);
}

function requireConfigured() {
  if (!isConfigured()) throw new Error('META_APP_ID / META_APP_SECRET are not set in backend/.env.');
}

function buildAuthUrl(platform, scopes, state) {
  requireConfigured();
  const params = new URLSearchParams({
    client_id: process.env.META_APP_ID,
    redirect_uri: redirectUriFor(platform),
    state,
    scope: scopes.join(','),
    response_type: 'code'
  });
  return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${params.toString()}`;
}

// Error `code` values Graph API returns for a token/permission problem
// that a retry can never fix on its own — the app is missing a scope
// (10, 200), the Page token was revoked/invalidated (190), or the
// session itself is gone (102). Anything else (rate limits, transient
// 500s, ...) is left for the caller to just retry next sweep.
const PERMANENT_AUTH_ERROR_CODES = new Set([10, 102, 190, 200]);

// Graph's own permission-error message names the exact scope it wanted,
// e.g. "This endpoint requires the 'pages_read_engagement' permission or
// the 'Page Public Content Access' feature." — pulling it out here is what
// lets explainPermissionError() below check that specific scope instead of
// guessing one.
const MISSING_SCOPE_RE = /requires the '([a-z_]+)' permission/i;

function graphError(path, body, status) {
  const info = body && body.error;
  const err = new Error(`Meta Graph API error on ${path}: ${(info && info.message) || status}`);
  if (info) {
    err.graphErrorCode = info.code;
    err.isPermanentAuthError = PERMANENT_AUTH_ERROR_CODES.has(info.code);
    const scopeMatch = MISSING_SCOPE_RE.exec(info.message || '');
    if (scopeMatch) err.missingScope = scopeMatch[1];
  }
  return err;
}

async function graphFetch(path, params = {}) {
  const url = `${GRAPH_BASE}${path}?${new URLSearchParams(params).toString()}`;
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok || body.error) throw graphError(path, body, res.status);
  return body;
}

/** Same as graphFetch but follows paging.next across every page, returning every item's data combined — for edges like /posts where a caller wants a full count/list rather than one page. */
async function graphFetchAll(path, params = {}) {
  let all = [];
  let url = `${GRAPH_BASE}${path}?${new URLSearchParams(params).toString()}`;
  while (url) {
    const res = await fetch(url);
    const body = await res.json();
    if (!res.ok || body.error) {
      throw new Error(`Meta Graph API error on ${path}: ${(body.error && body.error.message) || res.status}`);
    }
    all = all.concat(body.data || []);
    url = (body.paging && body.paging.next) || null;
  }
  return all;
}

/** Same as graphFetch but POST, params as form body — Graph API accepts either. */
async function graphPost(path, params = {}) {
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString()
  });
  const body = await res.json();
  if (!res.ok || body.error) throw graphError(path, body, res.status);
  return body;
}

/**
 * Same as graphPost but with a raw JSON body + Bearer auth header instead
 * of form encoding — the WhatsApp Cloud API's /messages endpoint needs
 * genuinely nested JSON (e.g. `{ text: { body: "..." } }`), which classic
 * Graph API's form-encoded-with-JSON-stringified-fields convention
 * (used elsewhere in this file, e.g. facebook.js's Messenger sendReply)
 * isn't documented to support for this specific endpoint.
 */
async function graphPostJson(path, accessToken, body) {
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(body)
  });
  const responseBody = await res.json();
  if (!res.ok || responseBody.error) throw graphError(path, responseBody, res.status);
  return responseBody;
}

/** Short-lived code -> short-lived user token -> long-lived user token. */
async function exchangeCodeForLongLivedUserToken(platform, code) {
  requireConfigured();
  const short = await graphFetch('/oauth/access_token', {
    client_id: process.env.META_APP_ID,
    client_secret: process.env.META_APP_SECRET,
    redirect_uri: redirectUriFor(platform),
    code
  });

  const long = await graphFetch('/oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: process.env.META_APP_ID,
    client_secret: process.env.META_APP_SECRET,
    fb_exchange_token: short.access_token
  });

  return {
    userAccessToken: long.access_token,
    expiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000).toISOString() : null
  };
}

/**
 * Same idea as exchangeCodeForLongLivedUserToken(), but for a `code`
 * obtained from the JS SDK's FB.login() (WhatsApp Embedded Signup) rather
 * than a browser redirect — there's no redirect_uri to validate against
 * since the browser never left the page, so Meta's code-exchange endpoint
 * is called without one (per Meta's Embedded Signup docs).
 */
async function exchangeEmbeddedSignupCodeForLongLivedUserToken(code) {
  requireConfigured();
  const short = await graphFetch('/oauth/access_token', {
    client_id: process.env.META_APP_ID,
    client_secret: process.env.META_APP_SECRET,
    code
  });

  const long = await graphFetch('/oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: process.env.META_APP_ID,
    client_secret: process.env.META_APP_SECRET,
    fb_exchange_token: short.access_token
  });

  return {
    userAccessToken: long.access_token,
    expiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000).toISOString() : null
  };
}

/** Re-exchanges a still-valid long-lived user token for a fresh one. */
async function refreshLongLivedUserToken(userAccessToken) {
  requireConfigured();
  const long = await graphFetch('/oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: process.env.META_APP_ID,
    client_secret: process.env.META_APP_SECRET,
    fb_exchange_token: userAccessToken
  });
  return {
    userAccessToken: long.access_token,
    expiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000).toISOString() : null
  };
}

/**
 * Asset ids (Page ids for pages_show_list, WhatsApp Business Account ids
 * for whatsapp_business_management, ...) a given scope is actually bound
 * to, per /debug_token's granular_scopes — see listPages()'s header for
 * why this is needed at all instead of just trusting the scope was
 * granted. Requires an app access token (app id + secret, not a user
 * token).
 */
async function grantedTargetIds(userAccessToken, scope = 'pages_show_list') {
  const appToken = `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`;
  const debug = await graphFetch('/debug_token', { input_token: userAccessToken, access_token: appToken });
  const granular = (debug.data && debug.data.granular_scopes) || [];
  const found = granular.find(g => g.scope === scope);
  return (found && found.target_ids) || [];
}

/**
 * Every Page (+ linked Instagram Business Account, if any) this user token
 * can manage.
 *
 * /me/accounts is the documented way to do this, but it only lists Pages
 * the person manages *directly* — for a Page owned by a Business Portfolio
 * (Business Manager), /me/accounts can come back empty even though the
 * OAuth grant is genuinely scoped to that Page (confirmed via
 * /debug_token's granular_scopes, which names the exact Page ids). When
 * that happens, fetch each granted Page id directly instead — that works
 * regardless of Business Portfolio ownership.
 */
async function listPages(userAccessToken) {
  // A Page object with no access_token is useless — every downstream
  // Graph call made with `undefined` serialized into the access_token
  // param fails with the same generic "must be granted before
  // impersonating a user's page" error regardless of which permission
  // each call needs, since Graph can't read any scope off a token that
  // isn't there. Worse, it looks "connected" in social_accounts while
  // silently being unusable. Filtered out on both paths below so
  // explainNoPages() reports the real problem instead of the account
  // "succeeding" broken.
  const withToken = list => (list || []).filter(page => page && page.access_token);

  const data = await graphFetch('/me/accounts', {
    access_token: userAccessToken,
    fields: 'id,name,access_token,instagram_business_account'
  });
  const directPages = withToken(data.data);
  if (directPages.length > 0) return directPages;

  // /me/accounts is the documented way to do this, but it only lists
  // Pages the person manages *directly* — for a Page owned by a Business
  // Portfolio (Business Manager), /me/accounts can come back empty even
  // though the OAuth grant is genuinely scoped to that Page (confirmed
  // via /debug_token's granular_scopes, which names the exact Page ids).
  // When that happens, fetch each granted Page id directly instead —
  // that works regardless of Business Portfolio ownership, PROVIDED the
  // fetch actually returns an access_token (a 200 with the field missing
  // means it doesn't, most likely because the app hasn't been assigned
  // as a Partner/connected app on that Business Portfolio).
  const pageIds = await grantedTargetIds(userAccessToken).catch(() => []);
  const fallbackPages = await Promise.all(pageIds.map(id =>
    graphFetch(`/${id}`, { access_token: userAccessToken, fields: 'id,name,access_token,instagram_business_account' }).catch(() => null)
  ));
  return withToken(fallbackPages);
}

/**
 * listPages() still coming back empty (i.e. the /debug_token fallback
 * above also found nothing to fetch, or fetching each Page id itself
 * failed) is almost never "this Facebook user has no Pages" — it's nearly
 * always a Meta-side config issue invisible from the OAuth dialog itself
 * (the picker screen happily lets you select Pages even when the
 * resulting token won't actually carry pages_show_list):
 *   1. The app is still in Development Mode and this Facebook user hasn't
 *      been added as a Developer/Admin/Tester on it (Meta App dashboard ->
 *      App Roles), so Advanced Access permissions get silently dropped
 *      from the token even though the consent screen showed them.
 *   2. The Page(s) picked are Business Portfolio-owned and something about
 *      that Portfolio (not just the app-Portfolio link, which the
 *      listPages() fallback already routes around) is blocking access.
 */
async function explainNoPages(userAccessToken, requestedScopes) {
  try {
    const perms = await graphFetch('/me/permissions', { access_token: userAccessToken });
    const granted = (perms.data || []).filter(p => p.status === 'granted').map(p => p.permission);
    const missing = requestedScopes.filter(s => !granted.includes(s));

    if (missing.length > 0) {
      return `Missing permission(s): ${missing.join(', ')}. This usually means the app is still in Development Mode and this Facebook account hasn't been added as a Developer/Admin/Tester (Meta App dashboard -> App Roles -> Roles), or the permission needs App Review before it works for other users.`;
    }

    const pageIds = await grantedTargetIds(userAccessToken);
    if (pageIds.length === 0) {
      return `pages_show_list shows as granted (${granted.join(', ')}) but per /debug_token it's scoped to zero Pages — the Page(s) picked in the consent dialog never actually got attached to the grant. Try reconnecting; if it persists, the app may need Advanced Access approval for pages_show_list, or this Facebook account needs to be added as a Developer/Admin/Tester (Meta App dashboard -> App Roles -> Roles).`;
    }
    return `pages_show_list is scoped to Page id(s) ${pageIds.join(', ')} per /debug_token, but fetching those Pages directly returned no usable access_token for any of them. For a Business Portfolio-owned Page, that means the personal OAuth grant alone isn't enough — the app itself needs to be connected to that Page's Business Portfolio: in Meta Business Suite, go to Business Settings -> Accounts -> Pages -> select the Page -> assign this app (or its Business) as a Partner with the needed Page tasks (Manage Page / Create Content / Messaging / etc.), or under Business Settings -> Accounts -> Apps, add this app and grant it access to the Page there.`;
  } catch (err) {
    return `Could not determine why (diagnostic call failed: ${err.message}).`;
  }
}

/**
 * Same diagnostic idea as explainNoPages(), but for an *already-connected*
 * account whose calls started failing with a permission error (the #10
 * "requires the '<scope>' permission" case graphError() tags as
 * missingScope). Distinguishes the two possible causes so the surfaced
 * error tells you which fix actually applies:
 *   - the OAuth grant never covered this Page for that scope (same
 *     Business-Portfolio granular_scopes gap grantedTargetIds() checks at
 *     connect time) -> reconnecting should fix it.
 *   - the grant does cover this Page, but the call still failed -> a Meta
 *     App Review / Advanced Access gap for that scope, which reconnecting
 *     cannot fix; it needs resolving on developers.facebook.com.
 */
async function explainPermissionError(userAccessToken, pageId, scope) {
  try {
    const pageIds = await grantedTargetIds(userAccessToken, scope);
    if (!pageIds.includes(pageId)) {
      return `The connected account's "${scope}" grant (per /debug_token) does not cover this Page (id ${pageId}) — reconnect via Connect Accounts and make sure this Page is selected when the OAuth consent screen asks.`;
    }
    return `"${scope}" is granted for this Page per /debug_token, so this is a Meta App Review / Advanced Access gap for "${scope}" (the "Page Public Content Access" feature the error names) rather than something reconnecting will fix — check this app's App Review -> Permissions and Features on developers.facebook.com.`;
  } catch (err) {
    return null; // diagnostic call itself failed (e.g. the stored user token is also dead) — not worth surfacing a second error on top of the first
  }
}

module.exports = {
  GRAPH_BASE,
  isConfigured,
  buildAuthUrl,
  exchangeCodeForLongLivedUserToken,
  exchangeEmbeddedSignupCodeForLongLivedUserToken,
  refreshLongLivedUserToken,
  listPages,
  grantedTargetIds,
  explainNoPages,
  explainPermissionError,
  graphFetch,
  graphFetchAll,
  graphPost,
  graphPostJson
};
