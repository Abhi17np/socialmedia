'use client';

import Competitors from '../../../src/social/Competitors';
import { useAuth } from '../../../src/AuthContext';

export default function CompetitorsPage() {
  const { authFetch, role } = useAuth();
  return <Competitors authFetch={authFetch} role={role} />;
}
