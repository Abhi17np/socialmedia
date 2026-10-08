'use client';

import { useRouter } from 'next/navigation';
import Posts from '../../../src/social/Posts';
import { useAuth } from '../../../src/AuthContext';
import { VIEW_TO_PATH } from '../../../src/viewPaths';

export default function PostsPage() {
  const { authFetch } = useAuth();
  const router = useRouter();
  return <Posts authFetch={authFetch} setCurrentView={(view) => router.push(VIEW_TO_PATH[view])} />;
}
