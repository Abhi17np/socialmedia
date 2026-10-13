// Shared formatting helpers across Sales Hub tabs — pulled out once it
// was duplicated in three separate files (DashboardTab, WorkspaceTab,
// SalesHub's PipelineTab/CompaniesTab).
export function money(amount, currency) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: currency || 'INR', maximumFractionDigits: 0 }).format(amount || 0);
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
