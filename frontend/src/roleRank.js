// Mirrors middleware/tenant.js's ROLE_RANK on the backend — this copy is
// UI-only (which nav links/controls to show), never the actual security
// boundary; the backend's own copy enforces that. Previously duplicated
// in SocialNav.jsx and Inbox.jsx, which only costs something the day the
// two copies drift apart.
export const ROLE_RANK = { viewer: 0, member: 1, admin: 2, owner: 3 };
export const atLeast = (role, min) => (ROLE_RANK[role] ?? 0) >= ROLE_RANK[min];
