'use client';

import Account from '../../../src/social/Account';
import { useAuth } from '../../../src/AuthContext';

export default function AccountPage() {
  const { authFetch, me } = useAuth();
  return <Account authFetch={authFetch} me={me} />;
}
