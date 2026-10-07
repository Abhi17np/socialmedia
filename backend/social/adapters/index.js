/**
 * Registry of social platform adapters — the social-module equivalent of
 * server.js's `const ADAPTERS = { db1, db2, ... }`. routes/social.js and
 * scheduler.js only ever go through this map, never a platform-specific
 * require, so adding facebook.js/instagram.js/linkedin.js/pinterest.js in
 * a later phase is a one-line addition here and nowhere else.
 *
 * Phase 1 registered youtube + google_business; Phase 2 added facebook +
 * instagram; Phase 3 adds linkedin (personal-profile posting only — see
 * linkedin.js's header on why Company Page posting isn't included yet);
 * Phase 4 adds whatsapp (messaging only — no publish/fetchPosts, see
 * whatsapp.js's header for why). x is still unregistered — a valid
 * `platform` value in the schema, but blocked on external approval per
 * the build spec, so any route touching it 404s with a clear "not
 * available yet" rather than crashing.
 */

const youtube = require('./youtube');
const googleBusiness = require('./google-business');
const facebook = require('./facebook');
const instagram = require('./instagram');
const linkedin = require('./linkedin');
const whatsapp = require('./whatsapp');

module.exports = {
  youtube,
  google_business: googleBusiness,
  facebook,
  instagram,
  linkedin,
  whatsapp
};
