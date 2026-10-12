'use client';

import { useEffect, useState } from 'react';
import { RefreshCw, UserPlus, Trash2, Users } from 'lucide-react';
import { API_BASE } from '../apiBase';
import { Page, PageBar, PageBody } from '../ui/page';
import {
  Button, IconButton, Panel, PanelHeader, Table, Th, Td, Input, Select, Field,
  Banner, Modal, ConfirmDialog, EmptyState, Skeleton, Avatar
} from '../ui';

const ROLES = ['viewer', 'member', 'admin', 'owner'];

const ROLE_HELP = {
  viewer: 'Read only — can see the dashboard, posts, inbox and analytics.',
  member: 'Can compose and schedule posts, and reply in the inbox.',
  admin: 'Everything a member can do, plus connecting channels and managing the team.',
  owner: 'Full access, including billing and plan changes.'
};

// Role management is admin+ only on the backend (middleware/tenant.js's
// requireRole) — this page assumes it's only reachable by someone who can
// actually use it (SocialNav hides it otherwise), but every action here
// still goes through the same gate server-side regardless.
function Team({ authFetch, role: myRole }) {
  const [members, setMembers] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({ email: '', password: '', role: 'member' });
  const [adding, setAdding] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(null);

  const load = () => {
    authFetch(`${API_BASE}/team/members`)
      .then((res) => res.json())
      .then((data) => setMembers(data.members || []))
      .catch((err) => setError(err.message));
  };

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAdd = async (e) => {
    e.preventDefault();
    setAdding(true);
    setError(null);
    try {
      const res = await authFetch(`${API_BASE}/team/members`, {
        method: 'POST',
        body: JSON.stringify(form)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not add teammate.');
      setMembers((prev) => [...prev, data.member]);
      setForm({ email: '', password: '', role: 'member' });
      setInviteOpen(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setAdding(false);
    }
  };

  const changeRole = async (member, role) => {
    try {
      const res = await authFetch(`${API_BASE}/team/members/${member.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ role })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setMembers((prev) => prev.map((m) => (m.id === member.id ? data.member : m)));
    } catch (err) {
      setError(err.message);
    }
  };

  const remove = async (member) => {
    try {
      const res = await authFetch(`${API_BASE}/team/members/${member.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not remove this teammate.');
      setMembers((prev) => prev.filter((m) => m.id !== member.id));
    } catch (err) {
      setError(err.message);
    } finally {
      setConfirmRemove(null);
    }
  };

  const assignableRoles = ROLES.filter((r) => r !== 'owner' || myRole === 'owner');

  return (
    <Page>
      <PageBar
        title="Team"
        count={members === null ? undefined : `${members.length} member${members.length === 1 ? '' : 's'}`}
        actions={
          <>
            <IconButton icon={RefreshCw} label="Refresh" onClick={load} />
            <Button variant="primary" icon={UserPlus} onClick={() => setInviteOpen(true)}>
              Add teammate
            </Button>
          </>
        }
      />

      <PageBody width="narrow">
        {error && <Banner tone="danger">{error}</Banner>}

        <Panel className="overflow-hidden">
          <PanelHeader title="Everyone with access" meta="and what they can do" />
          {members === null ? (
            <div className="p-4 space-y-3">
              <Skeleton className="h-9" />
              <Skeleton className="h-9" />
            </div>
          ) : members.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No teammates yet"
              description="Add the people who will compose posts and work the inbox with you."
              action={
                <Button variant="primary" onClick={() => setInviteOpen(true)}>
                  Add teammate
                </Button>
              }
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Member</Th>
                  <Th>Role</Th>
                  <Th>Joined</Th>
                  <Th align="right"> </Th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id} className="hover:bg-canvas transition-colors last:[&>td]:border-0">
                    <Td>
                      <span className="flex items-center gap-2.5 min-w-0">
                        <Avatar name={m.email} size={26} />
                        <span className="truncate">{m.email}</span>
                      </span>
                    </Td>
                    <Td>
                      <Select
                        className="h-7"
                        value={m.role}
                        onChange={(e) => changeRole(m, e.target.value)}
                        title={ROLE_HELP[m.role]}
                      >
                        {assignableRoles.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </Select>
                    </Td>
                    <Td>
                      <span className="text-muted tabular-nums">
                        {new Date(m.created_at).toLocaleDateString(undefined, {
                          day: 'numeric',
                          month: 'short',
                          year: 'numeric'
                        })}
                      </span>
                    </Td>
                    <Td align="right">
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={Trash2}
                        onClick={() => setConfirmRemove(m)}
                        aria-label={`Remove ${m.email}`}
                      />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
      </PageBody>

      <Modal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        title="Add a teammate"
        subtitle="They can sign in straight away with the temporary password you set."
        footer={
          <>
            <Button onClick={() => setInviteOpen(false)} disabled={adding}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleAdd}
              loading={adding}
              disabled={!form.email.trim() || form.password.length < 8}
            >
              Add teammate
            </Button>
          </>
        }
      >
        <form onSubmit={handleAdd} className="flex flex-col gap-3">
          <Field label="Email address">
            <Input
              type="email"
              required
              autoFocus
              placeholder="teammate@company.com"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </Field>
          <Field label="Temporary password" hint="At least 8 characters — they can change it later.">
            <Input
              type="password"
              minLength={8}
              required
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </Field>
          <Field label="Role" hint={ROLE_HELP[form.role]}>
            <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {assignableRoles.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </Field>
        </form>
      </Modal>

      <ConfirmDialog
        open={!!confirmRemove}
        title="Remove this teammate?"
        body={`${confirmRemove?.email} will lose access to this workspace immediately. Anything they were assigned stays assigned to them until someone reassigns it.`}
        confirmLabel="Remove"
        onCancel={() => setConfirmRemove(null)}
        onConfirm={() => remove(confirmRemove)}
      />
    </Page>
  );
}

export default Team;
