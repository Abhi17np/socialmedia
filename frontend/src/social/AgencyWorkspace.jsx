'use client';

import { useEffect, useState } from 'react';
import { RefreshCw, Building2, Plus, Check, Ban, Users } from 'lucide-react';
import { SOCIAL_API_BASE } from './api';
import { Page, PageBar, PageBody } from '../ui/page';
import {
  Button, IconButton, Panel, PanelHeader, Field, Input, Chip,
  Banner, EmptyState, Skeleton, ConfirmDialog
} from '../ui';
import { atLeast } from '../roleRank';

/*
 * Agency Workspace (migration 043) — lets this tenant see a READ-ONLY
 * aggregate rollup (connected accounts, followers, open interactions,
 * pending-approval posts, open crisis alerts — never raw messages or
 * post content) across other tenants it manages as their agency,
 * mutual-consent only: the client proposes by this tenant's slug, the
 * agency side separately approves. Either side can revoke at any time.
 */

const STATUS_TONE = { pending: 'warning', active: 'success', revoked: 'neutral' };
const NUM = (n) => (n === null || n === undefined ? '—' : n.toLocaleString());

function ProposeLinkForm({ onCreated, authFetch }) {
  const [agencySlug, setAgencySlug] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const propose = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await authFetch(`${SOCIAL_API_BASE}/agency/links`, {
        method: 'POST',
        body: JSON.stringify({ agencySlug: agencySlug.trim() })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not propose this link.');
      onCreated(data.link);
      setAgencySlug('');
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel className="p-3.5">
      {error && <Banner tone="danger" className="mb-2">{error}</Banner>}
      <div className="flex items-end gap-2">
        <Field label="Your agency's workspace slug" className="flex-1" hint="Ask your agency for the slug of the workspace they log into">
          <Input placeholder="e.g. acme-agency" value={agencySlug} onChange={(e) => setAgencySlug(e.target.value)} />
        </Field>
        <Button variant="primary" icon={Plus} loading={saving} onClick={propose} disabled={!agencySlug.trim()}>
          Propose link
        </Button>
      </div>
      <p className="text-[11px] text-subtle mt-2">
        This only PROPOSES sharing a read-only rollup of your account — nothing is shared until your agency separately
        approves it, and you can revoke access at any time.
      </p>
    </Panel>
  );
}

function LinkRow({ link, canManage, onApprove, onRevoke }) {
  const label = link.direction === 'as_agency'
    ? `Client: ${link.otherTenant?.name || link.otherTenant?.slug || 'unknown'}`
    : `Agency: ${link.otherTenant?.name || link.otherTenant?.slug || 'unknown'}`;

  return (
    <div className="flex items-center justify-between gap-3 px-3.5 py-2.5 border-b border-hairline last:border-0">
      <div className="min-w-0">
        <div className="text-xs font-medium text-ink truncate">{label}</div>
        <div className="text-[11px] text-subtle">{link.direction === 'as_agency' ? 'You are their agency' : 'You are the client'}</div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <Chip tone={STATUS_TONE[link.status]}>{link.status}</Chip>
        {canManage && link.status === 'pending' && link.direction === 'as_agency' && (
          <Button size="sm" variant="ghost" icon={Check} onClick={() => onApprove(link)}>Approve</Button>
        )}
        {canManage && link.status !== 'revoked' && (
          <Button size="sm" variant="ghost" icon={Ban} onClick={() => onRevoke(link)}>Revoke</Button>
        )}
      </div>
    </div>
  );
}

function ClientOverviewCard({ entry }) {
  const { tenant, overview } = entry;
  return (
    <Panel className="p-3.5">
      <div className="text-xs font-semibold text-ink mb-2">{tenant?.name || tenant?.slug || 'Unknown client'}</div>
      <div className="grid grid-cols-5 gap-2 text-[11px]">
        <div><div className="text-subtle">Accounts</div><div className="tabular-nums text-ink font-medium">{NUM(overview.connectedAccounts)}</div></div>
        <div><div className="text-subtle">Followers</div><div className="tabular-nums text-ink font-medium">{NUM(overview.totalFollowers)}</div></div>
        <div><div className="text-subtle">Open interactions</div><div className="tabular-nums text-ink font-medium">{NUM(overview.openInteractions)}</div></div>
        <div><div className="text-subtle">Awaiting approval</div><div className="tabular-nums text-ink font-medium">{NUM(overview.pendingApprovalPosts)}</div></div>
        <div><div className="text-subtle">Crisis alerts</div><div className="tabular-nums text-ink font-medium">{NUM(overview.openCrisisAlerts)}</div></div>
      </div>
    </Panel>
  );
}

function AgencyWorkspace({ authFetch, role }) {
  const canManage = atLeast(role, 'admin');
  const [links, setLinks] = useState(null);
  const [overview, setOverview] = useState(null);
  const [error, setError] = useState(null);
  const [confirmRevoke, setConfirmRevoke] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    setRefreshing(true);
    try {
      const [linksRes, overviewRes] = await Promise.all([
        authFetch(`${SOCIAL_API_BASE}/agency/links`),
        authFetch(`${SOCIAL_API_BASE}/agency/overview`)
      ]);
      const linksData = await linksRes.json();
      if (!linksRes.ok) throw new Error(linksData.error || 'Could not load agency links.');
      setLinks(linksData.links || []);

      const overviewData = await overviewRes.json();
      if (overviewRes.ok) setOverview(overviewData.clients || []);
      setError(null);
    } catch (err) {
      setError(err.message);
      setLinks([]);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const approve = async (link) => {
    try {
      const res = await authFetch(`${SOCIAL_API_BASE}/agency/links/${link.id}/approve`, { method: 'PATCH' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not approve this link.');
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const revoke = async (link) => {
    try {
      const res = await authFetch(`${SOCIAL_API_BASE}/agency/links/${link.id}/revoke`, { method: 'PATCH' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not revoke this link.');
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setConfirmRevoke(null);
    }
  };

  return (
    <Page>
      <PageBar
        title="Agency Workspace"
        actions={<IconButton icon={RefreshCw} label="Refresh" onClick={load} className={refreshing ? 'animate-[spin_1s_linear_infinite]' : undefined} />}
      />

      <PageBody width="narrow">
        {error && <Banner tone="danger">{error}</Banner>}

        <Banner tone="info" className="mb-0">
          Only aggregate counts ever cross between workspaces — never messages, post content, or anything else. Both
          sides must explicitly agree before anything is shared, and either side can revoke at any time.
        </Banner>

        {canManage && <ProposeLinkForm authFetch={authFetch} onCreated={() => load()} />}

        <Panel className="overflow-hidden">
          <PanelHeader title="Links" meta={links === null ? undefined : `${links.length}`} />
          {links === null ? (
            <div className="p-4"><Skeleton className="h-9" /></div>
          ) : links.length === 0 ? (
            <EmptyState
              icon={Building2}
              title="No agency links yet"
              description="Propose a link above if you work with an agency, or wait for a client to propose one to you."
            />
          ) : (
            links.map((l) => <LinkRow key={l.id} link={l} canManage={canManage} onApprove={approve} onRevoke={setConfirmRevoke} />)
          )}
        </Panel>

        {overview && overview.length > 0 && (
          <>
            <div className="flex items-center gap-1.5 mt-2">
              <Users size={14} className="text-subtle" />
              <span className="eyebrow">Your clients</span>
            </div>
            <div className="flex flex-col gap-3">
              {overview.map((entry) => <ClientOverviewCard key={entry.linkId} entry={entry} />)}
            </div>
          </>
        )}
      </PageBody>

      <ConfirmDialog
        open={!!confirmRevoke}
        title="Revoke this agency link?"
        body="This immediately stops any data from being shared between these two workspaces. This can't be undone, though a new link can be proposed later."
        confirmLabel="Revoke"
        onCancel={() => setConfirmRevoke(null)}
        onConfirm={() => revoke(confirmRevoke)}
      />
    </Page>
  );
}

export default AgencyWorkspace;
