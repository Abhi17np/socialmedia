// Shared formatting helpers across Sales Hub tabs — pulled out once it
// was duplicated in three separate files (DashboardTab, WorkspaceTab,
// SalesHub's PipelineTab/CompaniesTab).
export function money(amount, currency) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: currency || 'INR', maximumFractionDigits: 0 }).format(amount || 0);
}

// Deals aren't guaranteed to share a currency, so every dashboard
// aggregate the backend sends is grouped as {currency: amount}, never
// flattened into one number — summing ₹ and $ into a single total
// would just be wrong. This renders that map as "₹1,00,000 + $500",
// sorted by currency code so the order is stable across renders, and
// falls back to a plain zero when the tenant has no deals at all.
export function moneyByCurrency(amountsByCurrency) {
  const entries = Object.entries(amountsByCurrency || {}).filter(([, amt]) => amt !== 0);
  if (entries.length === 0) return money(0);
  return entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, amt]) => money(amt, currency))
    .join(' + ');
}

// middleware/validate.js's 400 response already carries the REAL reason a
// request was rejected — { error: 'Invalid request body.', issues: [{path,
// message}] } — but every Sales Hub form used to show only the generic
// top-level `error` string and silently drop `issues`, so a user who left
// a required field blank saw "Invalid request body." with no idea which
// field or why. This reads the same response shape every one of those
// forms already has in hand and surfaces the specific field + reason
// instead, falling back to the generic string only when the backend
// didn't send field-level detail at all (e.g. a 500, or a hand-rolled
// `res.status(400).json({error})` elsewhere that has no `issues`).
function humanizeFieldPath(path) {
  if (!path) return 'Value';
  const last = path.split('.').pop();
  const spaced = last.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.replace(/^./, (c) => c.toUpperCase());
}

export function errorMessage(data, fallback) {
  if (Array.isArray(data?.issues) && data.issues.length > 0) {
    return data.issues.map((i) => `${humanizeFieldPath(i.path)}: ${i.message}`).join('; ');
  }
  return data?.error || fallback;
}

// A GET /export route needs the Authorization header authFetch adds —
// a plain <a href> or window.open() can't carry that, so the file has
// to come back as a blob through authFetch and get "clicked" via a
// throwaway anchor instead.
export async function downloadViaAuthFetch(authFetch, url, filename) {
  const res = await authFetch(url);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Export failed.');
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}
