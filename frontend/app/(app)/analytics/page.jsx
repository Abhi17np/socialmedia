'use client';

import Analytics from '../../../src/social/Analytics';
import { useAuth } from '../../../src/AuthContext';

export default function AnalyticsPage() {
  const { authFetch, role } = useAuth();
  return <Analytics authFetch={authFetch} role={role} />;
}
