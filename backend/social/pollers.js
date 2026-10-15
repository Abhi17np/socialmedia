/**
 * Inbound sync: the piece Phase 1/2 never actually wired up. Every
 * adapter already exports fetchMentions()/fetchInbox()/fetchAnalytics()
 * (see youtube.js's header for the shared contract), but until now
 * nothing called them — routes/social.js's GET /social/mentions,
 * /social/inbox, and /social/analytics just read whatever was already in
 * those tables, which was always empty. This file runs two independent
 * sweeps that actually populate them, on plain setIntervals like
 * social/scheduler.js's reconciliation sweep (not BullMQ — inbound
 * polling has no per-item retry/ordering need the way publishing does,
 * just "try again next sweep" on failure):
 *   - sweep() — mentions + inbox, every 10 min
 *   - sweepAnalytics() — follower/reach/engagement snapshots, every 6h
 *     (its own slower cadence: these move slowly and the calls behind
 *     them are the most quota-sensitive, e.g. YouTube/Google Business)
 *   - sweepPostAnalytics() — per-post engagement, every 6h (same cadence
 *     as sweepAnalytics, no separate constant: no evidence per-post
 *     engagement needs a tighter poll than account-level, and a second,
 *     faster timer here would just be a second source of quota pressure
 *     with nothing concrete justifying it yet)
 *
 * Upserts on the tables' existing unique constraints, so a re-poll of
 * already-seen items is a no-op (mentions/inbox) or an in-place refresh
 * (analytics_snapshots/post_analytics) rather than a duplicate row.
 *
 * A genuinely new inbound message that resolves to a real contact also
 * fires the 'social_message_received' journey trigger (Social-to-
 * WhatsApp Conversion Journeys, routes/conversionJourneys.js) — reusing
 * lib/journeyEngine.js's existing fireWorkflowTrigger()/enrollContact(),
 * not a second notification path. Mentions/comments can't fire this
 * yet, same reason they can't resolve to a contact at all today (see
 * the fetchMentions block's own comment above).
 *
 * post_analytics' metric vocabulary is deliberately small and shared
 * across adapters (likes/comments/shares/views) — see each adapter's
 * fetchPostAnalytics for exactly which of these it returns and why
 * (reach/impressions-style metrics are withheld where the adapter
 * couldn't confirm a currently-stable API field for them; see
 * facebook.js/instagram.js's fetchPostAnalytics comments).
 */

const { getSocialClient } = require('./db');
const { getUsableAccount } = require('./accounts');
const { resolveContact } = require('../lib/contacts');
const { fireWorkflowTrigger } = require('../lib/journeyEngine');
const ADAPTERS = require('./adapters');

const POLL_INTERVAL_MS = 10 * 60 * 1000; // inbound APIs here are typically rate/quota-limited; no need to poll as tightly as the publish sweep
const ANALYTICS_POLL_INTERVAL_MS = 6 * 60 * 60 * 1000; // followers/reach move slowly and these calls are the most quota-sensitive (YouTube, GBP) — a separate, much slower cadence than mentions/inbox
// How far back to keep re-polling a published post's engagement. Bounds
// the sweep's cost as scheduled_posts grows instead of re-checking every
// post ever published; 30 days covers the window where a post's
// engagement is still realistically moving. Also doubles as this
// feature's backfill: the very first sweep after this migration/deploy
// picks up every already-published post inside this window, not just
// ones published from here on.
const POST_ANALYTICS_LOOKBACK_DAYS = 30;
let intervalHandle = null;
let analyticsIntervalHandle = null;
let postAnalyticsIntervalHandle = null;

/**
 * A permission/auth error (missing scope, revoked token, dead session —
 * see _meta-oauth.js's PERMANENT_AUTH_ERROR_CODES) can't be fixed by
 * retrying — every future sweep would fail on the exact same call and
 * just re-log the same error forever. Flip the account out of 'active'
 * so the next sweep's `.eq('status', 'active')` query stops picking it
 * up; GET /social/accounts already surfaces status, so this shows up as
 * needing reconnect instead of silently spamming the logs every 10 min.
 */
async function markAccountAuthError(client, account, err) {
  console.error(`[social/pollers] ${account.platform} account ${account.id} has a permanent auth/permission error and will not be polled again until reconnected: ${err.message}`);
  await client.from('social_accounts').update({ status: 'expired' }).eq('id', account.id);
}

async function pollAccount(client, row) {
  const usable = await getUsableAccount(row.tenant_id, row.id);
  if (!usable) return; // account row vanished between the list query and here
  const { account, adapter } = usable;

  if (typeof adapter.fetchMentions === 'function') {
    try {
      const mentions = await adapter.fetchMentions(account);
      if (mentions.length > 0) {
        // No adapter today returns the author's stable platform user id
        // (fetchMentions' contract only exposes a display-name `author`
        // string) — contact_id stays null here until that's added.
        // Unifying inbox_messages below is still the differentiator
        // demo: a WhatsApp thread resolves to a real contact even while
        // a comment's author doesn't yet.
        const rows = mentions.map(m => ({
          tenant_id: account.tenant_id,
          social_account_id: account.id,
          platform: account.platform,
          external_id: m.externalId,
          author: m.author || null,
          text: m.text || null,
          url: m.url || null,
          captured_at: m.capturedAt || new Date().toISOString()
        }));
        const { error } = await client.from('mentions').upsert(rows, { onConflict: 'platform,external_id', ignoreDuplicates: true });
        if (error) throw error;
      }
    } catch (err) {
      if (err.isPermanentAuthError) return markAccountAuthError(client, account, err);
      console.error(`[social/pollers] fetchMentions failed for ${account.platform} account ${account.id}:`, err.message);
    }
  }

  if (typeof adapter.fetchInbox === 'function') {
    try {
      const messages = await adapter.fetchInbox(account);
      if (messages.length > 0) {
        const rows = [];
        for (const m of messages) {
          // externalThreadId is the counterparty's own platform id (a
          // WhatsApp wa_id, a Messenger PSID) — this is the identity
          // resolve_contact() needs; a display name alone isn't stable
          // enough (people rename themselves, two people share a name).
          const contactId = await resolveContact(client, account.tenant_id, account.platform, m.externalThreadId, m.sender).catch(err => {
            console.error(`[social/pollers] resolveContact failed for ${account.platform} thread ${m.externalThreadId}:`, err.message);
            return null;
          });
          rows.push({
            tenant_id: account.tenant_id,
            social_account_id: account.id,
            contact_id: contactId,
            platform: account.platform,
            external_thread_id: m.externalThreadId,
            // Adapters return the conversation's current latest snippet, not
            // a stable per-message id (Graph API's /conversations endpoint
            // doesn't expose one without a second per-message fetch this
            // adapter layer doesn't do) — thread id + its own reported
            // timestamp is what makes a *new* message in an existing
            // thread upsert as a new row instead of being silently ignored
            // as a duplicate of the first message ever seen on that thread.
            external_message_id: m.externalMessageId || `${m.externalThreadId}:${m.receivedAt || ''}`,
            sender: m.sender || null,
            message: m.message || null,
            direction: 'inbound',
            received_at: m.receivedAt || new Date().toISOString()
          });
        }
        // .select() here is what makes the next step possible: with
        // ignoreDuplicates, PostgREST's upsert
        // returns only the rows that were actually newly inserted, not
        // ones skipped as an already-seen duplicate — exactly the
        // distinction needed to fire the social_message_received
        // journey trigger once per real new message, never once per
        // 10-min poll for the same historical ones.
        const { data: inserted, error } = await client.from('inbox_messages').upsert(rows, { onConflict: 'platform,external_message_id', ignoreDuplicates: true }).select('contact_id, platform, message');
        if (error) throw error;
        for (const row of inserted || []) {
          if (row.contact_id) {
            fireWorkflowTrigger(client, account.tenant_id, 'social_message_received', { contactId: row.contact_id, platform: row.platform, text: row.message })
              .catch((err) => console.error(`[social/pollers] fireWorkflowTrigger(social_message_received) failed for contact ${row.contact_id}:`, err.message));
          }
        }
      }
    } catch (err) {
      if (err.isPermanentAuthError) return markAccountAuthError(client, account, err);
      console.error(`[social/pollers] fetchInbox failed for ${account.platform} account ${account.id}:`, err.message);
    }
  }
}

async function sweep() {
  const client = getSocialClient();
  if (!client) return; // database not configured — nothing to poll yet

  const { data: accounts, error } = await client.from('social_accounts').select('id, platform, tenant_id').eq('status', 'active');
  if (error) {
    console.error('[social/pollers] Could not list active social_accounts:', error.message);
    return;
  }

  for (const row of accounts || []) {
    if (!ADAPTERS[row.platform]) continue; // e.g. a platform value with no registered adapter
    await pollAccount(client, row).catch(err => console.error(`[social/pollers] Unexpected failure polling account ${row.id}:`, err.message));
  }
}

/**
 * Same fetch-then-upsert shape as pollAccount() above, but for
 * fetchAnalytics() into analytics_snapshots — the table GET
 * /social/analytics/summary reads from. unique(social_account_id, metric,
 * captured_date) means a same-day re-poll updates that day's value in
 * place (a plain upsert, not ignoreDuplicates — the metric can move
 * within a day and later reads should see the latest count).
 */
async function pollAccountAnalytics(client, row) {
  const usable = await getUsableAccount(row.tenant_id, row.id);
  if (!usable) return;
  const { account, adapter } = usable;
  if (typeof adapter.fetchAnalytics !== 'function') return;

  try {
    const snapshots = await adapter.fetchAnalytics(account);
    if (snapshots.length === 0) return;
    const rows = snapshots.map(s => ({
      tenant_id: account.tenant_id,
      social_account_id: account.id,
      platform: account.platform,
      metric: s.metric,
      value: s.value,
      captured_date: s.capturedDate
    }));
    const { error } = await client.from('analytics_snapshots').upsert(rows, { onConflict: 'social_account_id,metric,captured_date' });
    if (error) throw error;
  } catch (err) {
    if (err.isPermanentAuthError) return markAccountAuthError(client, account, err);
    console.error(`[social/pollers] fetchAnalytics failed for ${account.platform} account ${account.id}:`, err.message);
  }
}

async function sweepAnalytics() {
  const client = getSocialClient();
  if (!client) return;

  const { data: accounts, error } = await client.from('social_accounts').select('id, platform, tenant_id').eq('status', 'active');
  if (error) {
    console.error('[social/pollers] Could not list active social_accounts for analytics:', error.message);
    return;
  }

  for (const row of accounts || []) {
    if (!ADAPTERS[row.platform]) continue;
    await pollAccountAnalytics(client, row).catch(err => console.error(`[social/pollers] Unexpected failure polling analytics for account ${row.id}:`, err.message));
  }
}

/**
 * Picks the externalPostId this post was actually given on one target
 * account, straight from platform_results (social/queue.js's
 * recordOutcome shape: `{status: 'published', externalPostId, url}` on
 * success, `{status: 'failed', error}` on failure). A missing entry
 * (not published to this account yet), a failed entry, or a 'published'
 * entry with no externalPostId (shouldn't happen, but adapters are
 * external input) all return null the same way — "nothing to poll yet",
 * not an error worth distinguishing here.
 */
function externalPostIdFor(platformResults, accountId) {
  const entry = platformResults && platformResults[accountId];
  if (!entry || entry.status !== 'published') return null;
  return entry.externalPostId || null;
}

/**
 * Same fetch-then-upsert shape as pollAccountAnalytics, but driven by
 * scheduled_posts rather than social_accounts — a published post can
 * target several accounts, and each (post, account) pair gets its own
 * independent fetchPostAnalytics call and its own rows in post_analytics.
 * unique(scheduled_post_id, social_account_id, metric, captured_date)
 * means a same-day re-poll updates that day's value in place, same
 * reasoning as pollAccountAnalytics's upsert.
 */
async function pollPostAnalytics(client, post) {
  for (const accountId of post.target_account_ids || []) {
    const externalPostId = externalPostIdFor(post.platform_results, accountId);
    if (!externalPostId) continue; // this account never got a successful publish for this post

    const usable = await getUsableAccount(post.tenant_id, accountId).catch(() => null);
    if (!usable) continue; // account deleted/disconnected since this post published
    const { account, adapter } = usable;
    if (typeof adapter.fetchPostAnalytics !== 'function') continue; // platform doesn't expose per-post metrics — see that adapter's header for why

    try {
      const metrics = await adapter.fetchPostAnalytics(account, externalPostId);
      if (metrics.length === 0) continue;
      const rows = metrics.map(m => ({
        tenant_id: post.tenant_id,
        scheduled_post_id: post.id,
        social_account_id: accountId,
        platform: account.platform,
        external_post_id: externalPostId,
        metric: m.metric,
        value: m.value,
        captured_date: m.capturedDate
      }));
      const { error } = await client.from('post_analytics').upsert(rows, { onConflict: 'scheduled_post_id,social_account_id,metric,captured_date' });
      if (error) throw error;
    } catch (err) {
      if (err.isPermanentAuthError) { await markAccountAuthError(client, account, err); continue; }
      console.error(`[social/pollers] fetchPostAnalytics failed for post ${post.id} / ${account.platform} account ${accountId}:`, err.message);
    }
  }
}

async function sweepPostAnalytics() {
  const client = getSocialClient();
  if (!client) return;

  const since = new Date(Date.now() - POST_ANALYTICS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: posts, error } = await client.from('scheduled_posts')
    .select('id, tenant_id, target_account_ids, platform_results')
    .eq('status', 'published')
    .gte('scheduled_at', since);
  if (error) {
    console.error('[social/pollers] Could not list published scheduled_posts for post analytics:', error.message);
    return;
  }

  for (const post of posts || []) {
    await pollPostAnalytics(client, post).catch(err => console.error(`[social/pollers] Unexpected failure polling post analytics for post ${post.id}:`, err.message));
  }
}

function start() {
  if (!intervalHandle) {
    intervalHandle = setInterval(() => { sweep().catch(err => console.error('[social/pollers] sweep failed:', err.message)); }, POLL_INTERVAL_MS);
    sweep().catch(err => console.error('[social/pollers] initial sweep failed:', err.message));
    console.log('[social/pollers] Inbound mentions/inbox sync started (10 min interval).');
  }
  if (!analyticsIntervalHandle) {
    analyticsIntervalHandle = setInterval(() => { sweepAnalytics().catch(err => console.error('[social/pollers] analytics sweep failed:', err.message)); }, ANALYTICS_POLL_INTERVAL_MS);
    sweepAnalytics().catch(err => console.error('[social/pollers] initial analytics sweep failed:', err.message));
    console.log('[social/pollers] Analytics sync started (6 hour interval).');
  }
  if (!postAnalyticsIntervalHandle) {
    postAnalyticsIntervalHandle = setInterval(() => { sweepPostAnalytics().catch(err => console.error('[social/pollers] post analytics sweep failed:', err.message)); }, ANALYTICS_POLL_INTERVAL_MS);
    sweepPostAnalytics().catch(err => console.error('[social/pollers] initial post analytics sweep failed:', err.message));
    console.log('[social/pollers] Post analytics sync started (6 hour interval).');
  }
}

function stop() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
  if (analyticsIntervalHandle) clearInterval(analyticsIntervalHandle);
  analyticsIntervalHandle = null;
  if (postAnalyticsIntervalHandle) clearInterval(postAnalyticsIntervalHandle);
  postAnalyticsIntervalHandle = null;
}

module.exports = { start, stop, sweep, sweepAnalytics, sweepPostAnalytics, externalPostIdFor };
