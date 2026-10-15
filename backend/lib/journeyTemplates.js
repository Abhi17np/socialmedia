/**
 * Prebuilt journey skeletons (task brief: "welcome series, lead nurture,
 * abandoned inquiry, re-engagement/win-back, event follow-up,
 * post-purchase, onboarding"). Every graph here is real and passes
 * lib/journeyGraph.js's validateGraph() — not placeholder names with no
 * working graph behind them. A tenant clones one via
 * POST /marketing/journeys/clone-template/:templateKey, then edits the
 * node configs (which templateId/tag/etc. to actually use) before
 * activating — these ship with empty-string config values a tenant must
 * fill in, never a guessed real template/tag id.
 */

function emailStep(id) {
  return { id, type: 'action', actionType: 'send_email', config: { templateId: '' } };
}
function delayStep(id, amount, unit) {
  return { id, type: 'delay', config: { amount, unit } };
}
function tagStep(id, tag) {
  return { id, type: 'action', actionType: 'add_tag', config: { tag } };
}
function fieldStep(id, field, value) {
  return { id, type: 'action', actionType: 'update_field', config: { field, value } };
}
function taskStep(id, subject) {
  return { id, type: 'action', actionType: 'create_task', config: { subject } };
}

/** Builds a flat node/edge graph from an ordered, purely-sequential list of step specs — a journey template is always a simple line; branching is left for the tenant to add in the editor. */
function chain(triggerType, triggerConfig, steps) {
  const nodes = [{ id: 't', type: 'trigger' }, ...steps];
  const edges = [];
  let prev = 't';
  for (const step of steps) {
    edges.push({ id: `e_${prev}_${step.id}`, source: prev, target: step.id });
    prev = step.id;
  }
  return { triggerType, triggerConfig, graph: { nodes, edges } };
}

const JOURNEY_TEMPLATES = {
  welcome_series: {
    name: 'Welcome series',
    description: 'A new subscriber gets a welcome email, then a getting-started email two days later.',
    ...chain('contact_tag_added', { tag: 'newsletter' }, [
      emailStep('welcome'), delayStep('delay1', 2, 'days'), emailStep('getting_started'), tagStep('tag_onboarded', 'onboarded')
    ])
  },
  lead_nurture: {
    name: 'Lead nurture',
    description: 'A new lead is tagged, waits a day, then gets a nurture email and a follow-up task for their owner.',
    ...chain('contact_tag_added', { tag: 'lead' }, [
      delayStep('wait1', 1, 'days'), emailStep('nurture_email'), taskStep('followup_task', 'Follow up with new lead')
    ])
  },
  reengagement: {
    name: 'Re-engagement / win-back',
    description: 'Tag contacts as "cold" to send a win-back email, then update their lifecycle stage if they stay quiet.',
    ...chain('contact_tag_added', { tag: 'cold' }, [
      emailStep('winback_email'), delayStep('wait_response', 5, 'days'), fieldStep('mark_lapsed', 'lifecycle_stage', 'other')
    ])
  },
  event_followup: {
    name: 'Event follow-up',
    description: 'Tag attendees after an event to send a thank-you email and a follow-up a few days later.',
    ...chain('contact_tag_added', { tag: 'event-attendee' }, [
      emailStep('thank_you'), delayStep('wait1', 3, 'days'), emailStep('followup_email')
    ])
  },
  post_purchase: {
    name: 'Post-purchase',
    description: 'A deal is won: thank the customer, then check in a week later.',
    ...chain('deal_won', {}, [
      emailStep('thank_you'), delayStep('wait1', 7, 'days'), emailStep('check_in_email')
    ])
  },
  onboarding: {
    name: 'Customer onboarding',
    description: 'After a deal is won, send a series of onboarding emails spaced a few days apart.',
    ...chain('deal_won', {}, [
      emailStep('step1'), delayStep('wait1', 3, 'days'), emailStep('step2'), delayStep('wait2', 4, 'days'), emailStep('step3')
    ])
  },
  abandoned_inquiry: {
    name: 'Abandoned inquiry',
    description: 'A lead goes quiet after initial contact — nudge them, then update status if there is still no movement.',
    ...chain('contact_tag_added', { tag: 'inquiry' }, [
      delayStep('wait1', 2, 'days'), emailStep('nudge_email'), delayStep('wait2', 5, 'days'), fieldStep('mark_unqualified', 'lead_status', 'unqualified')
    ])
  }
};

// chain() is also reused by routes/conversionJourneys.js to build its
// own simple trigger -> delay -> send_whatsapp graphs — same linear-
// graph primitive, not a second copy of the edge-building logic.
module.exports = { JOURNEY_TEMPLATES, chain };
