'use client';

import { createContext, useContext } from 'react';

// Provided by app/(app)/layout.jsx, consumed by every page under it via
// useAuth() — the Next.js equivalent of the authFetch/role props the old
// single-page App.jsx threaded through VIEWS[currentView] directly.
export const AuthContext = createContext(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth() must be called from inside the (app) route group — AuthContext has no provider above it.');
  return ctx;
}
