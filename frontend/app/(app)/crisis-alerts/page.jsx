'use client';

import CrisisAlerts from '../../../src/social/CrisisAlerts';
import { useAuth } from '../../../src/AuthContext';

export default function CrisisAlertsPage() {
  const { authFetch, role } = useAuth();
  return <CrisisAlerts authFetch={authFetch} role={role} />;
}
