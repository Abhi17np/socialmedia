// Dashboard.jsx and Posts.jsx still call setCurrentView('social-accounts')
// etc. internally (unchanged from the pre-Next.js version, to avoid
// touching their internals for this migration) — each page.jsx passes a
// setCurrentView shim built from this map instead of real router state.
export const VIEW_TO_PATH = {
  'social-dashboard': '/dashboard',
  'social-compose': '/compose',
  'social-posts': '/posts',
  'social-inbox': '/inbox',
  'social-analytics': '/analytics',
  'social-accounts': '/connect-accounts',
  'social-team': '/team',
  'social-billing': '/billing'
};
