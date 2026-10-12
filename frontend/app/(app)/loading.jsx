// Shown automatically by Next.js while a route segment under (app) is
// loading — e.g. the brief moment a page's own JS chunk is fetched on
// first navigation to it. Mirrors the real page frame (56px top bar,
// then content) so the switch doesn't shift the layout.
export default function AppLoading() {
  return (
    <div className="h-full flex flex-col">
      <div className="h-14 shrink-0 bg-card border-b border-hairline px-4 flex items-center gap-3">
        <div className="skeleton h-3 w-24 rounded" />
        <div className="skeleton h-8 flex-1 max-w-md rounded-ui" />
      </div>
      <div className="px-6 py-5 flex flex-col gap-5 max-w-[1280px]">
        <div className="skeleton h-[76px] rounded-card" />
        <div className="grid grid-cols-1 xl:grid-cols-[1.6fr_1fr] gap-5">
          <div className="skeleton h-64 rounded-card" />
          <div className="skeleton h-64 rounded-card" />
        </div>
      </div>
    </div>
  );
}
