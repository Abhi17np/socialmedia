'use client';

import AgencyWorkspace from '../../../src/social/AgencyWorkspace';
import { useAuth } from '../../../src/AuthContext';

export default function AgencyWorkspacePage() {
  const { authFetch, role } = useAuth();
  return <AgencyWorkspace authFetch={authFetch} role={role} />;
}
