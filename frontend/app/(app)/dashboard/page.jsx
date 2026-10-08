'use client';

import { useRouter } from 'next/navigation';
import Dashboard from '../../../src/social/Dashboard';
import { useAuth } from '../../../src/AuthContext';
import { VIEW_TO_PATH } from '../../../src/viewPaths';

export default function DashboardPage() {
  const { authFetch } = useAuth();
  const router = useRouter();
  return <Dashboard authFetch={authFetch} setCurrentView={(view) => router.push(VIEW_TO_PATH[view])} />;
}
