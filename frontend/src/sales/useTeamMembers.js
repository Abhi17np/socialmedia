'use client';

import { useEffect, useState } from 'react';
import { API_BASE } from '../apiBase';

// Every "assign owner" picker across Sales Hub (companies, contacts,
// deals, bulk actions, automation rules) needs the same tenant member
// list — one hook instead of each tab re-fetching GET /team/members.
export function useTeamMembers(authFetch) {
  const [members, setMembers] = useState([]);
  useEffect(() => {
    authFetch(`${API_BASE}/team/members`).then((r) => r.json()).then((d) => setMembers(d.members || [])).catch(() => {});
  }, [authFetch]);
  return members;
}
