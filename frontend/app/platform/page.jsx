'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import PlatformDashboard from '../../src/platform/PlatformDashboard';

export default function PlatformPage() {
  const router = useRouter();
  const [token, setToken] = useState(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    setToken(localStorage.getItem('platform_token'));
    setChecked(true);
  }, []);

  useEffect(() => {
    if (checked && !token) router.replace('/platform/login');
  }, [checked, token, router]);

  if (!checked || !token) return null;
  return <PlatformDashboard token={token} />;
}
