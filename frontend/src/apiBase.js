// One place for the backend's base URL — every other file imports this
// instead of reading the env var itself. Must be NEXT_PUBLIC_-prefixed:
// Next.js only inlines env vars with that prefix into client bundles.
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:5000/api/v1';
