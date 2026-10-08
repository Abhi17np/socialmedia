'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// / itself renders nothing — it only decides which real page to land on.
export default function RootPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace(localStorage.getItem('token') ? '/dashboard' : '/login');
  }, [router]);
  return null;
}
