// Shared formatting helpers across Sales Hub tabs — pulled out once it
// was duplicated in three separate files (DashboardTab, WorkspaceTab,
// SalesHub's PipelineTab/CompaniesTab).
export function money(amount, currency) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: currency || 'INR', maximumFractionDigits: 0 }).format(amount || 0);
}
