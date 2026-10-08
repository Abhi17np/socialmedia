'use client';

import Billing from '../../../src/social/Billing';
import { useAuth } from '../../../src/AuthContext';

export default function BillingPage() {
  const { authFetch } = useAuth();
  return <Billing authFetch={authFetch} />;
}
