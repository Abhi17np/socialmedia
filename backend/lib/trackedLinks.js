/**
 * Pure URL/UTM helpers for Tracked Links (migration 039) — no DB, no
 * network. routes/trackedLinks.js uses appendUtmParams() to build the
 * redirect target; routes/tracking.js uses parseUtmParams() to parse an
 * incoming pageview URL into the columns site_visits now has. Keeping
 * both pure and separate from their DB-touching callers is what makes
 * them exhaustively unit-testable without a database.
 */

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

/**
 * Appends UTM query params to a URL, overwriting any same-named param
 * the URL already had (so re-tagging a link someone already tagged
 * doesn't produce two conflicting utm_source values). Throws a plain
 * Error (not a crash) for a string that isn't a valid absolute URL —
 * callers are expected to show that as a clear 400, not swallow it.
 */
function appendUtmParams(url, params) {
  const parsed = new URL(url); // throws TypeError on an invalid URL — callers catch and surface a clear error
  for (const key of UTM_KEYS) {
    if (params[key]) parsed.searchParams.set(key, String(params[key]));
  }
  return parsed.toString();
}

/**
 * Parses the five UTM query params out of a URL, returning null for
 * each one that's absent — never an empty string, so a DB column this
 * feeds stays genuinely `null` (no known value) rather than `''`
 * (a value that happens to be empty), which matters when later code
 * checks `utm_medium is not null` to mean "we know where this came
 * from." Returns all-null for an unparseable URL rather than throwing —
 * tracking.js's own pageview endpoint already validates `url` is a
 * non-empty string before this is ever called; a malformed URL from a
 * tenant's own site shouldn't break their whole pageview pixel.
 */
function parseUtmParams(url) {
  const out = { utm_source: null, utm_medium: null, utm_campaign: null, utm_content: null, utm_term: null };
  try {
    const parsed = new URL(url);
    for (const key of UTM_KEYS) {
      const value = parsed.searchParams.get(key);
      if (value) out[key] = value.slice(0, 200); // same bound lead_form_submissions' own UTM columns already use
    }
  } catch {
    // not a parseable absolute URL — out stays all-null, see header
  }
  return out;
}

/** The public redirect URL for a tracked link — pasted into a social post's content in place of the real destination. */
function shortUrlFor(id, apiBase) {
  return `${apiBase}/t/${id}`;
}

module.exports = { appendUtmParams, parseUtmParams, shortUrlFor, UTM_KEYS };
