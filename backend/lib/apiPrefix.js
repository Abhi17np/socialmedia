/**
 * The one place the versioned API path prefix is defined. server.js
 * mounts every route under this; the OAuth adapters (_meta-oauth.js,
 * _google-oauth.js, linkedin.js) build their redirect_uri from it too —
 * previously each of those three files hardcoded '/api/social/...'
 * (missing the '/v1'), which doesn't match where server.js actually
 * mounts the callback route, so every real OAuth connect flow would
 * have failed in production with a redirect_uri mismatch. One shared
 * constant means that can't drift apart again.
 */
const API_PREFIX = '/api/v1';

module.exports = { API_PREFIX };
