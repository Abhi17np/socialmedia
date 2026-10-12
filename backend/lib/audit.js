/**
 * Append-only record of sensitive tenant actions (migrations/009). Never
 * blocks or fails the request it's called from — an audit write failing
 * is a logging problem, not a reason to roll back a teammate removal or
 * a billing change that already succeeded, so every call site awaits
 * this but the function itself swallows its own errors (logged, not
 * thrown).
 */
async function recordAudit(client, { tenantId, actorUserId, action, targetType, targetId, metadata }) {
  try {
    const { error } = await client.from('audit_log').insert({
      tenant_id: tenantId,
      actor_user_id: actorUserId || null,
      action,
      target_type: targetType || null,
      target_id: targetId ? String(targetId) : null,
      metadata: metadata || {}
    });
    if (error) console.error(`[audit] Could not record "${action}":`, error.message);
  } catch (err) {
    console.error(`[audit] Could not record "${action}":`, err.message);
  }
}

module.exports = { recordAudit };
