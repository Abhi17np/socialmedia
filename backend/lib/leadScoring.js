/**
 * Lead scoring: a tenant-configurable rule set (lead_scoring_rules,
 * migration 016), not a hardcoded formula. Each active rule whose
 * condition matches a contact contributes its points (which can be
 * negative, to dock a score) to that contact's lead_score.
 *
 * Recomputed whenever a contact is created or updated (see
 * routes/sales.js) or a real marketing engagement happens (an email
 * open/click, a form submission, a journey completion — see
 * routes/marketingEmail.js's tracking endpoints, routes/leadForms.js,
 * lib/journeyEngine.js's finishEnrollment) — a rule added or changed
 * after that takes effect the next time the contact is touched again,
 * not retroactively for every existing contact. That keeps a rule
 * edit/engagement event a cheap, synchronous write instead of a batch
 * job over the whole tenant.
 *
 * Phase 6 adds four BEHAVIORAL condition types — marketing engagement
 * folded into the same scoring model Sales Hub already had, per the
 * task brief's "engagement scoring combined with lead scoring" — and
 * MQL lifecycle automation: crossing a tenant-configurable score
 * threshold auto-promotes a subscriber/lead to lifecycle_stage='mql'
 * and fires the new 'became_mql' journey trigger. Promotion only ever
 * moves a contact UP from subscriber/lead to mql; it never touches a
 * contact already further along (sql/opportunity/customer/evangelist)
 * or the manual 'other' marker — a real sale shouldn't be silently
 * reset to "just qualified" because their score happened to dip.
 */

const { recordAudit } = require('./audit');
// NOT required at the top: lib/journeyEngine.js itself calls
// recomputeLeadScore() (to score a 'journey_completed_any' rule live the
// moment a journey finishes) — a top-level require here would deadlock
// Node's circular-require resolution (whichever of the two modules
// loads second would get an empty, not-yet-populated export from the
// other). Required lazily, inside the one function that needs it, which
// only ever runs after both modules have finished loading.

const STATIC_CONDITION_TYPES = ['has_email', 'has_phone', 'has_company', 'tag_equals', 'lead_status_equals'];
const BEHAVIORAL_CONDITION_TYPES = ['email_opened_any', 'email_clicked_any', 'form_submitted_any', 'journey_completed_any'];
const CONDITION_TYPES = [...STATIC_CONDITION_TYPES, ...BEHAVIORAL_CONDITION_TYPES];

function ruleMatches(rule, contact, behavioral) {
  switch (rule.condition_type) {
    case 'has_email': return !!contact.email;
    case 'has_phone': return !!contact.phone;
    case 'has_company': return !!contact.company_id;
    case 'tag_equals': return (contact.tags || []).includes(rule.condition_value);
    case 'lead_status_equals': return contact.lead_status === rule.condition_value;
    case 'email_opened_any': return !!behavioral?.emailOpened;
    case 'email_clicked_any': return !!behavioral?.emailClicked;
    case 'form_submitted_any': return !!behavioral?.formSubmitted;
    case 'journey_completed_any': return !!behavioral?.journeyCompleted;
    default: return false;
  }
}

/** One cheap existence check (`.limit(1)`) per behavioral fact — never a full count, this only needs to know "at least one", and only runs at all when some active rule actually needs it. email_campaign_recipients already carries its own opened_at/clicked_at timestamps (migration 027), so this needs no join into email_events at all. */
async function getBehavioralFacts(client, tenantId, contactId) {
  const [openedRow, clickedRow, formRow, journeyRow] = await Promise.all([
    client.from('email_campaign_recipients').select('id').eq('tenant_id', tenantId).eq('contact_id', contactId).not('opened_at', 'is', null).limit(1).maybeSingle(),
    client.from('email_campaign_recipients').select('id').eq('tenant_id', tenantId).eq('contact_id', contactId).not('clicked_at', 'is', null).limit(1).maybeSingle(),
    client.from('lead_form_submissions').select('id').eq('tenant_id', tenantId).eq('contact_id', contactId).limit(1).maybeSingle(),
    client.from('workflow_enrollments').select('id').eq('tenant_id', tenantId).eq('contact_id', contactId).in('status', ['completed', 'goal_met']).limit(1).maybeSingle()
  ]);
  return { emailOpened: !!openedRow.data, emailClicked: !!clickedRow.data, formSubmitted: !!formRow.data, journeyCompleted: !!journeyRow.data };
}

const LIFECYCLE_RANK = { subscriber: 0, lead: 1, mql: 2, sql: 3, opportunity: 4, customer: 5, evangelist: 6, other: -1 };

/** Pure guard, independently unit-tested: only subscriber/lead (rank 0 or 1) are eligible for auto-promotion. 'other' is rank -1 on purpose — a deliberate manual marker (e.g. Phase 4's "mark_lapsed" journey step), not a progression stage — and must NOT be treated as "below mql" just because its rank number is smaller. */
function isEligibleForMqlPromotion(lifecycleStage) {
  const rank = LIFECYCLE_RANK[lifecycleStage];
  return rank !== undefined && rank >= 0 && rank < LIFECYCLE_RANK.mql;
}

/** Promotes subscriber/lead -> mql once the tenant's configured threshold is crossed. Never demotes, never touches a contact already past mql or marked 'other'. Audit-logged; fires the 'became_mql' journey trigger (fire-and-forget, never throws into the caller). */
async function maybePromoteToMql(client, tenantId, contact, score) {
  if (!isEligibleForMqlPromotion(contact.lifecycle_stage)) return contact;
  const { data: tenant } = await client.from('tenants').select('marketing_mql_threshold').eq('id', tenantId).maybeSingle();
  const threshold = tenant?.marketing_mql_threshold ?? 50;
  if (score < threshold) return contact;

  const { data: promoted, error } = await client.from('contacts').update({ lifecycle_stage: 'mql' }).eq('id', contact.id).eq('tenant_id', tenantId).select('*').single();
  if (error) throw error;
  await recordAudit(client, { tenantId, actorUserId: null, action: 'marketing.contact_became_mql', targetType: 'contact', targetId: contact.id, metadata: { score, threshold } });
  const { fireWorkflowTrigger } = require('./journeyEngine');
  await fireWorkflowTrigger(client, tenantId, 'became_mql', { contactId: contact.id });
  return promoted;
}

async function recomputeLeadScore(client, tenantId, contactId) {
  const { data: contact, error: contactError } = await client
    .from('contacts').select('id, email, phone, company_id, tags, lead_status, lifecycle_stage')
    .eq('id', contactId).eq('tenant_id', tenantId).maybeSingle();
  if (contactError) throw contactError;
  if (!contact) return null;

  const { data: rules, error: rulesError } = await client
    .from('lead_scoring_rules').select('condition_type, condition_value, points')
    .eq('tenant_id', tenantId).eq('is_active', true);
  if (rulesError) throw rulesError;

  const needsBehavioral = (rules || []).some((r) => BEHAVIORAL_CONDITION_TYPES.includes(r.condition_type));
  const behavioral = needsBehavioral ? await getBehavioralFacts(client, tenantId, contactId) : null;

  const score = (rules || []).reduce((sum, rule) => sum + (ruleMatches(rule, contact, behavioral) ? rule.points : 0), 0);

  // Returns the FULL fresh row, not just the score — this update bumps
  // the row's optimistic-concurrency version (bump_version() trigger,
  // migration 023), so a caller that only grabbed the score and kept
  // using an earlier read's `version` would hand its client a stale
  // value, making their very next save spuriously 409 conflict.
  const { data: updated, error: updateError } = await client
    .from('contacts').update({ lead_score: score })
    .eq('id', contactId).eq('tenant_id', tenantId).select('*').single();
  if (updateError) throw updateError;

  return maybePromoteToMql(client, tenantId, updated, score);
}

module.exports = { recomputeLeadScore, ruleMatches, getBehavioralFacts, isEligibleForMqlPromotion, CONDITION_TYPES, STATIC_CONDITION_TYPES, BEHAVIORAL_CONDITION_TYPES, LIFECYCLE_RANK };
