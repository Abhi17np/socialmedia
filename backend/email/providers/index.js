/**
 * Registry of email/calendar providers — same shape as
 * social/adapters/index.js, so routes/salesEmail.js never requires a
 * provider module directly. Each provider exports
 * { PROVIDER, SCOPES, isConfigured, buildAuthUrl, exchangeCode }.
 */

const gmail = require('./gmail');
const microsoft365 = require('./microsoft365');

module.exports = {
  gmail,
  microsoft365
};
