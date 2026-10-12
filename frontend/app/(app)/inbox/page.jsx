'use client';

import Inbox from '../../../src/social/Inbox';
import { useAuth } from '../../../src/AuthContext';

export default function InboxPage() {
  const { authFetch, role, me } = useAuth();
  return <Inbox authFetch={authFetch} role={role} me={me} />;
}
