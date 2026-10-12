'use client';

import MarketingHub from '../../../src/marketing/MarketingHub';
import { useAuth } from '../../../src/AuthContext';

export default function MarketingPage() {
  const { authFetch, role } = useAuth();
  return <MarketingHub authFetch={authFetch} role={role} />;
}
