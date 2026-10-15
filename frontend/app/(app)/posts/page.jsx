'use client';

import { useRouter } from 'next/navigation';
import Posts from '../../../src/social/Posts';
import { useAuth } from '../../../src/AuthContext';
import { VIEW_TO_PATH } from '../../../src/viewPaths';

export default function PostsPage() {
  const { authFetch, role } = useAuth();
  const router = useRouter();
  return <Posts authFetch={authFetch} role={role} setCurrentView={(view) => router.push(VIEW_TO_PATH[view])} />;
}
