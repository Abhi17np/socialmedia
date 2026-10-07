/**
 * Supabase client for this app's one shared Postgres project (tenants,
 * users, social_accounts, contacts, etc. — see backend/migrations/).
 * Uses the service-role key, which bypasses RLS by design: tenant
 * isolation here is enforced at the app layer (backend/middleware/tenant.js
 * + backend/lib/query.js), not by Postgres row-level security — see the
 * strategy doc's Multi-Tenancy section for why that's the right call for
 * a backend that's the only thing ever holding this key.
 */

const { createClient } = require('@supabase/supabase-js');

let cachedClient = null;

function isConfigured() {
  return !!(process.env.SUPABASE_URL_SOCIAL && process.env.SUPABASE_KEY_SOCIAL);
}

function getSocialClient() {
  if (!isConfigured()) return null;
  if (!cachedClient) {
    try {
      cachedClient = createClient(process.env.SUPABASE_URL_SOCIAL, process.env.SUPABASE_KEY_SOCIAL);
    } catch (e) {
      console.error('Failed to create social Supabase client:', e.message);
      return null;
    }
  }
  return cachedClient;
}

module.exports = { getSocialClient, isConfigured };
