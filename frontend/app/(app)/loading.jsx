// Shown automatically by Next.js while a route segment under (app) is
// loading — e.g. the brief moment a page's own JS chunk is fetched on
// first navigation to it. The old single-page app had no equivalent: a
// view switch there was an instant in-memory state change with nothing
// to show a loading state for, but it also meant there was no real route
// to prefetch, no browser history entry, and no deep link.
export default function AppLoading() {
  return (
    <div style={{ padding: '2.5rem' }}>
      <div className="skeleton-block" style={{ width: 220, height: 28, marginBottom: '0.75rem' }} />
      <div className="skeleton-block" style={{ width: 380, height: 16, marginBottom: '2rem' }} />
      <div className="skeleton-block" style={{ width: '100%', height: 120, borderRadius: 'var(--radius-md)' }} />
    </div>
  );
}
