/**
 * AI Assist endpoints — mounted at `${API_PREFIX}/ai` behind requireAuth,
 * same tenant-scoping discipline as routes/social.js. Every draft here
 * is text the human still has to send themselves (Composer's Publish
 * button, Inbox's Send reply button); nothing in this file posts or
 * messages on its own. See backend/lib/ai.js for the actual Anthropic
 * calls and backend/lib/entitlements.js for the per-tenant monthly cap.
 */
const express = require('express');
const { getSocialClient } = require('../social/db');
const { scoped } = require('../lib/query');
const { assertWithinLimit, recordUsage } = require('../lib/entitlements');
const { validate } = require('../middleware/validate');
const { requireRole } = require('../middleware/tenant');
const { draftPostSchema } = require('../lib/schemas');
const { draftPost, draftReply } = require('../lib/ai');

const router = express.Router();

function requireSocialClient(res) {
  const client = getSocialClient();
  if (!client) {
    res.status(503).json({ error: 'Database not configured (SUPABASE_URL_SOCIAL / SUPABASE_KEY_SOCIAL in .env).' });
    return null;
  }
  return client;
}

// member+ matches Compose's own nav gating (SocialNav.jsx) — drafting is
// harmless on its own, but keeping the bar consistent avoids a viewer
// having more reach through AI Assist than through the Composer itself.
router.post('/compose/draft', requireRole('member'), validate(draftPostSchema), async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;

  try {
    await assertWithinLimit(client, req.tenantId, 'aiGenerationsPerMonth');
    const { brief, platforms, tone } = req.body;
    const { draft } = await draftPost({ brief, platforms, tone });
    await recordUsage(client, req.tenantId, 'aiGenerationsPerMonth');
    res.json({ draft });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// viewer+ matches /social/inbox/:id/reply's own gating — no stricter
// bar for drafting a reply than for actually sending one.
router.post('/inbox/:id/draft-reply', async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;

  try {
    await assertWithinLimit(client, req.tenantId, 'aiGenerationsPerMonth');

    const { data: message, error: msgErr } = await scoped(client, req.tenantId, 'inbox_messages').select('*').eq('id', req.params.id).single();
    if (msgErr || !message) return res.status(404).json({ error: 'Message not found.' });

    let contactName = message.sender;
    let history = [];
    if (message.contact_id) {
      const [{ data: contact }, { data: priorMessages }] = await Promise.all([
        scoped(client, req.tenantId, 'contacts').select('display_name').eq('id', message.contact_id).maybeSingle(),
        scoped(client, req.tenantId, 'inbox_messages').select('message, direction, received_at')
          .eq('contact_id', message.contact_id).order('received_at', { ascending: false }).limit(10)
      ]);
      if (contact && contact.display_name) contactName = contact.display_name;
      history = (priorMessages || []).reverse().map(m => ({ text: m.message, direction: m.direction }));
    }

    const { data: savedReplies } = await scoped(client, req.tenantId, 'saved_replies').select('title, body');

    const { draft } = await draftReply({
      contactName,
      platform: message.platform,
      incomingMessage: message.message,
      history,
      savedReplies: savedReplies || []
    });

    await recordUsage(client, req.tenantId, 'aiGenerationsPerMonth');
    res.json({ draft });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

module.exports = router;
