/**
 * Lead scoring: a tenant-configurable rule set (lead_scoring_rules,
 * migration 016), not a hardcoded formula. Each active rule whose
 * condition matches a contact contributes its points (which can be
 * negative, to dock a score) to that contact's lead_score.
 *
 * Recomputed whenever a contact is created or updated (see
 * routes/sales.js) — a rule added or changed after that takes effect
 * the next time the contact itself is touched, not retroactively for
 * every existing contact. That keeps a rule edit a cheap, synchronous
 * write instead of a batch job over the whole tenant.
 */

const CONDITION_TYPES = ['has_email', 'has_phone', 'has_company', 'tag_equals', 'lead_status_equals'];

function ruleMatches(rule, contact) {
  switch (rule.condition_type) {
    case 'has_email': return !!contact.email;
    case 'has_phone': return !!contact.phone;
    case 'has_company': return !!contact.company_id;
    case 'tag_equals': return (contact.tags || []).includes(rule.condition_value);
    case 'lead_status_equals': return contact.lead_status === rule.condition_value;
    default: return false;
  }
}

async function recomputeLeadScore(client, tenantId, contactId) {
  const { data: contact, error: contactError } = await client
    .from('contacts').select('id, email, phone, company_id, tags, lead_status')
    .eq('id', contactId).eq('tenant_id', tenantId).maybeSingle();
  if (contactError) throw contactError;
  if (!contact) return null;

  const { data: rules, error: rulesError } = await client
    .from('lead_scoring_rules').select('condition_type, condition_value, points')
    .eq('tenant_id', tenantId).eq('is_active', true);
  if (rulesError) throw rulesError;

  const score = (rules || []).reduce((sum, rule) => sum + (ruleMatches(rule, contact) ? rule.points : 0), 0);

  const { data: updated, error: updateError } = await client
    .from('contacts').update({ lead_score: score })
    .eq('id', contactId).eq('tenant_id', tenantId).select('lead_score').single();
  if (updateError) throw updateError;
  return updated.lead_score;
}

module.exports = { recomputeLeadScore, ruleMatches, CONDITION_TYPES };
