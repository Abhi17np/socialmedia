'use client';

import Inbox from '../../../src/social/Inbox';
import { useAuth } from '../../../src/AuthContext';

export default function InboxPage() {
  const { authFetch } = useAuth();
  return <Inbox authFetch={authFetch} />;
}
