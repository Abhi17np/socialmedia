'use client';

import DecisionSimulator from '../../../src/social/DecisionSimulator';
import { useAuth } from '../../../src/AuthContext';

export default function DecisionSimulatorPage() {
  const { authFetch, role } = useAuth();
  return <DecisionSimulator authFetch={authFetch} role={role} />;
}
