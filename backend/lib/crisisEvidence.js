/**
 * Shared "what messages actually made up this alert's window" query —
 * routes/crisis.js's detail view and routes/ai.js's summarize endpoint
 * both need the exact same real evidence, so it lives in one place
 * rather than two copies that could drift.
 */
const { scoped } = require('./query');

async function gatherEvidence(client, tenantId, windowStart, windowEnd) {
  const [{ data: inboxRows }, { data: mentionRows }] = await Promise.all([
    scoped(client, tenantId, 'inbox_messages').select('id, platform, sender, message, received_at')
      .eq('direction', 'inbound').gte('received_at', windowStart).lte('received_at', windowEnd),
    scoped(client, tenantId, 'mentions').select('id, platform, author, text, url, captured_at')
      .gte('captured_at', windowStart).lte('captured_at', windowEnd)
  ]);
  const messages = [
    ...(inboxRows || []).map((m) => ({ source: 'inbox', id: m.id, platform: m.platform, author: m.sender, text: m.message, url: null, at: m.received_at })),
    ...(mentionRows || []).map((m) => ({ source: 'mention', id: m.id, platform: m.platform, author: m.author, text: m.text, url: m.url, at: m.captured_at }))
  ];
  messages.sort((a, b) => new Date(a.at) - new Date(b.at));
  return messages;
}

module.exports = { gatherEvidence };
