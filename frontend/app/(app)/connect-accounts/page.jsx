'use client';

import ConnectAccounts from '../../../src/social/ConnectAccounts';
import { useAuth } from '../../../src/AuthContext';

export default function ConnectAccountsPage() {
  const { authFetch } = useAuth();
  return <ConnectAccounts authFetch={authFetch} />;
}
