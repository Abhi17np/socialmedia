'use client';

import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Link2, Copy, Check } from 'lucide-react';
import { SOCIAL_API_BASE } from './api';
import { API_BASE } from '../apiBase';
import {
  Button, IconButton, Panel, PanelHeader, Table, Th, Td, Input, Select,
  Banner, EmptyState, Skeleton
} from '../ui';
import { channelLabel } from '../ui/channel';
import { atLeast } from '../roleRank';

/*
 * Social Revenue Attribution (migration 039) — reuses Marketing Hub's
 * existing multi-touch attribution engine entirely (GET
 * /social/attribution, an ungated second mount of the same report
 * /marketing/attribution already serves — see backend/routes/social.js's
 * own comment on why), plus Tracked Links, the thing a tenant actually
 * pastes into a post to generate the social-channel touchpoints that
 * report reads.
 */

const MODELS = [
  { value: 'linear', label: 'Linear (split evenly)' },
  { value: 'first_touch', label: 'First touch' },
  { value: 'last_touch', label: 'Last touch' }
];

function CreateLinkForm({ onCreated, authFetch, canManage }) {
  const [destinationUrl, setDestinationUrl] = useState('');
  const [platform, setPlatform] = useState('facebook');
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  if (!canManage) return null;

  const create = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await authFetch(`${API_BASE}/social/tracked-links`, {
        method: 'POST',
        body: JSON.stringify({ destinationUrl: destinationUrl.trim(), platform, label: label.trim() || undefined })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create this tracked link.');
      onCreated(data.link);
      setDestinationUrl(''); setLabel('');
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-3.5 border-b border-hairline flex flex-col gap-2">
      {error && <Banner tone="danger">{error}</Banner>}
      <div className="flex items-center gap-2 flex-wrap">
        <Input
          className="flex-1 min-w-[220px]"
          placeholder="Destination URL — e.g. https://yoursite.com/landing"
          value={destinationUrl}
          onChange={(e) => setDestinationUrl(e.target.value)}
        />
        <Select className="w-32" value={platform} onChange={(e) => setPlatform(e.target.value)}>
          {['facebook', 'instagram', 'youtube', 'linkedin', 'google_business'].map((p) => (
            <option key={p} value={p}>{channelLabel(p)}</option>
          ))}
        </Select>
        <Input className="w-40" placeholder="Label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} />
        <Button variant="primary" icon={Link2} loading={saving} onClick={create} disabled={!destinationUrl.trim()}>
          Create tracked link
        </Button>
      </div>
      <p className="text-[11px] text-subtle">
        Paste the short URL this gives you into a post's content instead of the real destination — every click is tagged with
        real UTM params and, once your site's tracking snippet reports the resulting pageview, feeds this page's revenue report.
      </p>
    </div>
  );
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <IconButton
      icon={copied ? Check : Copy}
      label="Copy short URL"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    />
  );
}

function TrackedLinksPanel({ authFetch, canManage }) {
  const [links, setLinks] = useState(null);
  const [posts, setPosts] = useState([]);
  const [error, setError] = useState(null);

  const load = async () => {
    try {
      const [linksRes, postsRes] = await Promise.all([
        authFetch(`${API_BASE}/social/tracked-links`),
        authFetch(`${SOCIAL_API_BASE}/posts`)
      ]);
      const linksData = await linksRes.json();
      if (!linksRes.ok) throw new Error(linksData.error || 'Could not load tracked links.');
      setLinks(linksData.links || []);
      const postsData = await postsRes.json();
      if (postsRes.ok) setPosts(postsData.posts || []);
      setError(null);
    } catch (err) {
      setError(err.message);
      setLinks([]);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const attachPost = async (link, scheduledPostId) => {
    try {
      const res = await authFetch(`${API_BASE}/social/tracked-links/${link.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ scheduledPostId: scheduledPostId || null })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not update this link.');
      setLinks((prev) => prev.map((l) => (l.id === link.id ? data.link : l)));
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <Panel className="overflow-hidden">
      <PanelHeader title="Tracked links" meta="paste one into a post to generate real social-attribution data" />
      <CreateLinkForm authFetch={authFetch} canManage={canManage} onCreated={(link) => setLinks((prev) => [link, ...(prev || [])])} />
      {error && <div className="p-3"><Banner tone="danger">{error}</Banner></div>}
      {links === null ? (
        <div className="p-4"><Skeleton className="h-9" /></div>
      ) : links.length === 0 ? (
        <EmptyState icon={Link2} title="No tracked links yet" description="Create one above to start measuring real revenue from your posts." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Link</Th>
              <Th>Platform</Th>
              <Th align="right">Clicks</Th>
              <Th>Attached post</Th>
            </tr>
          </thead>
          <tbody>
            {links.map((link) => (
              <tr key={link.id} className="hover:bg-canvas transition-colors last:[&>td]:border-0">
                <Td>
                  <div className="flex items-center gap-1.5 min-w-0">
                    <CopyButton text={link.shortUrl} />
                    <div className="min-w-0">
                      <div className="text-ink truncate max-w-[220px]">{link.label || link.destination_url}</div>
                      <div className="text-subtle truncate max-w-[220px]">{link.destination_url}</div>
                    </div>
                  </div>
                </Td>
                <Td>{channelLabel(link.platform)}</Td>
                <Td align="right"><span className="tabular-nums">{link.click_count}</span></Td>
                <Td>
                  {canManage ? (
                    <Select className="h-7 w-44" value={link.scheduled_post_id || ''} onChange={(e) => attachPost(link, e.target.value)}>
                      <option value="">— none —</option>
                      {posts.map((p) => (
                        <option key={p.id} value={p.id}>{(p.content || '(no text)').slice(0, 40)}</option>
                      ))}
                    </Select>
                  ) : (
                    <span className="text-subtle">{posts.find((p) => p.id === link.scheduled_post_id)?.content?.slice(0, 40) || '—'}</span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Panel>
  );
}

function AttributionReportPanel({ authFetch }) {
  const [model, setModel] = useState('linear');
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    setRefreshing(true);
    try {
      const res = await authFetch(`${SOCIAL_API_BASE}/attribution?model=${model}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load the attribution report.');
      setReport(data);
      setError(null);
    } catch (err) {
      setError(err.message);
      setReport(null);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  const byCurrencyUnattributed = useMemo(() => report?.unattributedRevenue || [], [report]);

  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        title="Revenue by channel"
        meta={report ? `${report.attributedDealCount} of ${report.dealCount} won deals attributed` : undefined}
        actions={
          <>
            <Select className="h-7 w-44" value={model} onChange={(e) => setModel(e.target.value)}>
              {MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </Select>
            <IconButton icon={RefreshCw} label="Refresh" onClick={load} className={refreshing ? 'animate-[spin_1s_linear_infinite]' : undefined} />
          </>
        }
      />
      {error && <div className="p-3"><Banner tone="danger">{error}</Banner></div>}
      {!report ? (
        <div className="p-4"><Skeleton className="h-9" /></div>
      ) : report.byChannel.length === 0 ? (
        <EmptyState
          icon={Link2}
          title="No attributed revenue yet"
          description="Once a won deal's contact has a resolved touchpoint (an email open/click, a form, a journey, WhatsApp, or a social click through a tracked link), it shows up here."
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Channel</Th>
              <Th>Source</Th>
              <Th align="right">Deals</Th>
              <Th align="right">Revenue</Th>
            </tr>
          </thead>
          <tbody>
            {report.byChannel.map((row, i) => (
              <tr key={i} className={`hover:bg-canvas transition-colors last:[&>td]:border-0 ${row.channel === 'social' ? 'bg-brand-subtle/30' : ''}`}>
                <Td>{row.channel === 'social' ? <span className="font-medium text-brand">Social</span> : row.channel}</Td>
                <Td>{row.sourceName}</Td>
                <Td align="right"><span className="tabular-nums">{row.dealCount}</span></Td>
                <Td align="right"><span className="tabular-nums font-medium">{row.currency} {row.totalCredited.toLocaleString()}</span></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {byCurrencyUnattributed.length > 0 && (
        <div className="p-3 border-t border-hairline text-[11px] text-subtle">
          Unattributed (no known touchpoint before close):{' '}
          {byCurrencyUnattributed.map((u) => `${u.currency} ${u.total.toLocaleString()}`).join(', ')}
        </div>
      )}
    </Panel>
  );
}

function RevenueAttribution({ authFetch, role }) {
  const canManage = atLeast(role, 'member');
  return (
    <div className="flex flex-col gap-3">
      <AttributionReportPanel authFetch={authFetch} />
      <TrackedLinksPanel authFetch={authFetch} canManage={canManage} />
    </div>
  );
}

export default RevenueAttribution;
