'use client';

import Composer from '../../../src/social/Composer';
import { useAuth } from '../../../src/AuthContext';

export default function ComposePage() {
  const { authFetch } = useAuth();
  return <Composer authFetch={authFetch} />;
}
