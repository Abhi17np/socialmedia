'use client';

import Analytics from '../../../src/social/Analytics';
import { useAuth } from '../../../src/AuthContext';

export default function AnalyticsPage() {
  const { authFetch } = useAuth();
  return <Analytics authFetch={authFetch} />;
}
