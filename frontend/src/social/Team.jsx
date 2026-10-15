'use client';

import { useEffect, useState } from 'react';
import { RefreshCw, UserPlus, Trash2, Users } from 'lucide-react';
import { API_BASE } from '../apiBase';
import { SOCIAL_API_BASE } from './api';
import { Page, PageBar, PageBody } from '../ui/page';
import {
  Button, IconButton, Panel, PanelHeader, Table, Th, Td, Input, Select, Field,
  Banner, Modal, ConfirmDialog, EmptyState, Skeleton, Avatar, Textarea
} from '../ui';

// Comma-separated plain-text lists, not a tag-input widget — this is an
// editorial settings form an admin fills out occasionally, not a
// high-frequency interaction that would justify the extra UI
// complexity. Each list caps at 50 entries server-side (lib/schemas.js).
const toList = (text) => text.split(',').map((s) => s.trim()).filter(Boolean);
const fromList = (list) => (list || []).join(', ');

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
  const [requireApproval, setRequireApproval] = useState(null);
  const [savingApproval, setSavingApproval] = useState(false);

  const loadApprovalSetting = () => {
    if (myRole !== 'admin' && myRole !== 'owner') return;
    authFetch(`${SOCIAL_API_BASE}/approval-settings`)
      .then((res) => res.json())
      .then((data) => setRequireApproval(!!data.requireApproval))
      .catch(() => {});
  };
  useEffect(loadApprovalSetting, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Brand Memory (migration 037) — applied to every AI Assist draft/
  // hashtag/repurpose call, see backend/lib/brandMemory.js. Read access
  // is unrestricted server-side, but editing is admin+ only here, same
  // bar as the approval setting above.
  const [brandForm, setBrandForm] = useState(null);
  const [savingBrand, setSavingBrand] = useState(false);
  const [brandSaved, setBrandSaved] = useState(false);

  const loadBrandMemory = () => {
    if (myRole !== 'admin' && myRole !== 'owner') return;
    authFetch(`${SOCIAL_API_BASE}/brand-memory`)
      .then((res) => res.json())
      .then((data) => {
        const p = data.profile || {};
        setBrandForm({
          tone: p.tone || '',
          audience: p.audience || '',
          preferredTerms: fromList(p.preferred_terms),
          bannedTerms: fromList(p.banned_terms),
          prohibitedClaims: fromList(p.prohibited_claims),
          approvedMessaging: fromList(p.approved_messaging)
        });
      })
      .catch(() => {});
  };
  useEffect(loadBrandMemory, []); // eslint-disable-line react-hooks/exhaustive-deps

  const saveBrandMemory = async () => {
    setSavingBrand(true);
    setBrandSaved(false);
    try {
      const res = await authFetch(`${SOCIAL_API_BASE}/brand-memory`, {
        method: 'PATCH',
        body: JSON.stringify({
          tone: brandForm.tone.trim() || undefined,
          audience: brandForm.audience.trim() || undefined,
          preferredTerms: toList(brandForm.preferredTerms),
          bannedTerms: toList(brandForm.bannedTerms),
          prohibitedClaims: toList(brandForm.prohibitedClaims),
          approvedMessaging: toList(brandForm.approvedMessaging)
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save brand memory.');
      setBrandSaved(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingBrand(false);
    }
  };

  const toggleApproval = async () => {
    setSavingApproval(true);
    try {
      const res = await authFetch(`${SOCIAL_API_BASE}/approval-settings`, {
        method: 'PATCH',
        body: JSON.stringify({ requireApproval: !requireApproval })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not update this setting.');
      setRequireApproval(data.requireApproval);
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingApproval(false);
    }
  };

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

        {requireApproval !== null && (
          <Panel className="p-3.5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-semibold text-ink">Require approval before posting</div>
                <p className="text-[11px] text-muted mt-0.5">
                  When on, a post scheduled by a member (not an admin/owner) waits in "Needs review" until an admin approves it.
                </p>
              </div>
              <Button size="sm" variant={requireApproval ? 'primary' : 'secondary'} loading={savingApproval} onClick={toggleApproval}>
                {requireApproval ? 'On' : 'Off'}
              </Button>
            </div>
          </Panel>
        )}

        {brandForm !== null && (
          <Panel className="p-3.5">
            <div className="mb-2">
              <div className="text-xs font-semibold text-ink">Brand Memory</div>
              <p className="text-[11px] text-muted mt-0.5">
                Applied to every AI Assist draft, hashtag suggestion, and repurposed variant. Leave anything blank to skip it —
                nothing here is required.
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Tone" hint="e.g. warm, concise, no corporate jargon">
                <Input value={brandForm.tone} onChange={(e) => setBrandForm({ ...brandForm, tone: e.target.value })} />
              </Field>
              <Field label="Audience" hint="Who the account is talking to">
                <Input value={brandForm.audience} onChange={(e) => setBrandForm({ ...brandForm, audience: e.target.value })} />
              </Field>
              <Field label="Preferred terms" hint="Comma-separated — used where relevant">
                <Textarea
                  rows={2}
                  value={brandForm.preferredTerms}
                  onChange={(e) => setBrandForm({ ...brandForm, preferredTerms: e.target.value })}
                />
              </Field>
              <Field label="Banned terms" hint="Comma-separated — never used">
                <Textarea
                  rows={2}
                  value={brandForm.bannedTerms}
                  onChange={(e) => setBrandForm({ ...brandForm, bannedTerms: e.target.value })}
                />
              </Field>
              <Field label="Prohibited claims" hint="Comma-separated — never claimed">
                <Textarea
                  rows={2}
                  value={brandForm.prohibitedClaims}
                  onChange={(e) => setBrandForm({ ...brandForm, prohibitedClaims: e.target.value })}
                />
              </Field>
              <Field label="Approved messaging" hint="Comma-separated key messages to draw on">
                <Textarea
                  rows={2}
                  value={brandForm.approvedMessaging}
                  onChange={(e) => setBrandForm({ ...brandForm, approvedMessaging: e.target.value })}
                />
              </Field>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Button size="sm" variant="primary" loading={savingBrand} onClick={saveBrandMemory}>
                Save brand memory
              </Button>
              {brandSaved && <span className="text-[11px] text-success">Saved.</span>}
            </div>
          </Panel>
        )}

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
