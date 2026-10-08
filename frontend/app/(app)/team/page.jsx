'use client';

import Team from '../../../src/social/Team';
import { useAuth } from '../../../src/AuthContext';

export default function TeamPage() {
  const { authFetch, role } = useAuth();
  return <Team authFetch={authFetch} role={role} />;
}
