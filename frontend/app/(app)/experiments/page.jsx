'use client';

import Experiments from '../../../src/social/Experiments';
import { useAuth } from '../../../src/AuthContext';

export default function ExperimentsPage() {
  const { authFetch, role } = useAuth();
  return <Experiments authFetch={authFetch} role={role} />;
}
