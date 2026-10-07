/**
 * The selling feature, as a function call: resolve a platform-specific
 * sender (a WhatsApp wa_id, an Instagram PSID, a Facebook PSID) to one
 * tenant-scoped contact, creating it on first contact. Call this from
 * every inbound-message/mention ingestion point (social/adapters'
 * webhook handlers) before writing the inbox_messages/mentions row, and
 * stamp its result onto that row's contact_id.
 *
 * The find-or-create itself lives in Postgres (resolve_contact() in
 * migrations/003_contacts.sql) — concurrent webhook retries for the same
 * new contact need one atomic statement, not a check-then-insert race
 * from here.
 */
async function resolveContact(client, tenantId, platform, externalId, displayName) {
  const { data, error } = await client.rpc('resolve_contact', {
    p_tenant_id: tenantId,
    p_platform: platform,
    p_external_id: externalId,
    p_display_name: displayName || null
  });
  if (error) throw error;
  return data; // uuid
}

module.exports = { resolveContact };
