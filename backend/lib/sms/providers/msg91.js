/**
 * MSG91 Flow API (api.msg91.com) — the common India-market SMS provider,
 * with TRAI DLT (Distributed Ledger Technology) compliance: every send
 * must carry a registered dlt_entity_id and dlt_template_id or Indian
 * carriers silently drop it. Those two live in connection.config (set
 * once per tenant via their MSG91/DLT registration), not per-send — see
 * docs/MARKETING_HUB_IMPLEMENTATION.md's Phase 7 entry for why DLT
 * registration itself (an offline, provider-side process) is out of
 * this codebase's scope. Untested against a real MSG91 account here.
 */
function isConfigured(connection) {
  return !!(connection?.secret && connection?.config?.dltEntityId && connection?.config?.dltTemplateId);
}

async function send({ connection, message }) {
  if (!isConfigured(connection)) throw new Error('MSG91 connection is missing an API key or DLT entity/template id.');
  const res = await fetch('https://api.msg91.com/api/v5/flow/', {
    method: 'POST',
    headers: { authkey: connection.secret, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender: connection.fromNumber,
      short_url: '0',
      mobiles: message.to.replace(/^\+/, ''),
      DLT_TE_ID: connection.config.dltTemplateId,
      VAR1: message.body
    })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.type === 'error') throw new Error(`MSG91 send failed: ${json.message || 'unknown error'}`);
  return { externalId: json.request_id || null };
}

module.exports = { name: 'msg91', isConfigured, send };
