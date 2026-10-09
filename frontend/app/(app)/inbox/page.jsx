'use client';

import Inbox from '../../../src/social/Inbox';
import { useAuth } from '../../../src/AuthContext';

export default function InboxPage() {
  const { authFetch, role } = useAuth();
  return <Inbox authFetch={authFetch} role={role} />;
}
