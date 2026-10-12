'use client';

import SalesHub from '../../../src/sales/SalesHub';
import { useAuth } from '../../../src/AuthContext';

export default function SalesPage() {
  const { authFetch, role } = useAuth();
  return <SalesHub authFetch={authFetch} role={role} />;
}
