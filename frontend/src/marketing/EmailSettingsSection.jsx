'use client';

import { useEffect, useState } from 'react';
import { RefreshCw, Plus, ShieldAlert, Check } from 'lucide-react';
import { API_BASE } from '../apiBase';
import { Button, Panel, PanelHeader, Table, Th, Td, Input, Select, Field, Banner, Modal, EmptyState, Skeleton, Chip } from '../ui';

const MKT_API_BASE = `${API_BASE}/marketing`;

const PROVIDER_LABELS = { mock: 'Mock (local/dev — always works, sends nowhere real)', smtp: 'SMTP (SES, Mailgun, Postmark, Gmail…)', sendgrid: 'SendGrid', resend: 'Resend' };

function VerifiedChip({ ok }) {
  return <Chip tone={ok ? 'success' : 'neutral'}>{ok ? 'Verified' : 'Not verified'}</Chip>;
}

export default function EmailSettingsSection({ authFetch, canAdmin }) {
  const [connection, setConnection] = useState(undefined); // undefined = loading, null = none configured
  const [domains, setDomains] = useState(null);
  const [address, setAddress] = useState('');
  const [addressSaved, setAddressSaved] = useState(false);
  const [error, setError] = useState(null);

  const [connForm, setConnForm] = useState({ provider: 'mock', fromName: '', fromEmail: '', replyTo: '', host: '', port: '', user: '', secret: '' });
  const [savingConn, setSavingConn] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const [domainOpen, setDomainOpen] = useState(false);
  const [domainForm, setDomainForm] = useState({ domain: '', dkimSelector: '' });
  const [checkingId, setCheckingId] = useState(null);

  const load = () => {
    authFetch(`${MKT_API_BASE}/email/connection`).then((r) => r.json()).then((d) => {
      setConnection(d.connection);
      if (d.connection) setConnForm({ provider: d.connection.provider, fromName: d.connection.from_name, fromEmail: d.connection.from_email, replyTo: d.connection.reply_to || '', host: d.connection.config?.host || '', port: d.connection.config?.port || '', user: d.connection.config?.user || '', secret: '' });
    }).catch((e) => setError(e.message));
    authFetch(`${MKT_API_BASE}/email/domains`).then((r) => r.json()).then((d) => setDomains(d.domains || [])).catch(() => {});
    authFetch(`${MKT_API_BASE}/email/settings`).then((r) => r.json()).then((d) => setAddress(d.marketingPostalAddress || '')).catch(() => {});
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const saveConnection = async () => {
    setSavingConn(true);
    setError(null);
    try {
      const body = {
        provider: connForm.provider, fromName: connForm.fromName, fromEmail: connForm.fromEmail, replyTo: connForm.replyTo || undefined,
        config: connForm.provider === 'smtp' ? { host: connForm.host, port: Number(connForm.port), user: connForm.user } : {},
        secret: connForm.secret || undefined
      };
      const res = await authFetch(`${MKT_API_BASE}/email/connection`, { method: 'PUT', body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.issues ? data.error.issues.map((i) => i.message).join(', ') : (data.error || 'Could not save connection.'));
      setConnection(data.connection);
      setConnForm((f) => ({ ...f, secret: '' }));
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingConn(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await authFetch(`${MKT_API_BASE}/email/connection/test`, { method: 'POST', body: JSON.stringify({ to: testTo.trim() }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Test send failed.');
      setTestResult({ ok: true, message: `Sent via ${data.provider}.` });
    } catch (err) {
      setTestResult({ ok: false, message: err.message });
    } finally {
      setTesting(false);
    }
  };

  const saveAddress = async () => {
    try {
      const res = await authFetch(`${MKT_API_BASE}/email/settings`, { method: 'PATCH', body: JSON.stringify({ marketingPostalAddress: address }) });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Could not save address.'); }
      setAddressSaved(true);
      setTimeout(() => setAddressSaved(false), 2000);
    } catch (err) {
      setError(err.message);
    }
  };

  const addDomain = async () => {
    try {
      const res = await authFetch(`${MKT_API_BASE}/email/domains`, { method: 'POST', body: JSON.stringify(domainForm) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not add domain.');
      setDomains((prev) => [data.domain, ...(prev || [])]);
      setDomainOpen(false);
      setDomainForm({ domain: '', dkimSelector: '' });
    } catch (err) {
      setError(err.message);
    }
  };

  const checkDomain = async (domain) => {
    setCheckingId(domain.id);
    try {
      const res = await authFetch(`${MKT_API_BASE}/email/domains/${domain.id}/check`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Check failed.');
      setDomains((prev) => (prev || []).map((d) => (d.id === domain.id ? data.domain : d)));
    } catch (err) {
      setError(err.message);
    } finally {
      setCheckingId(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {error && <Banner tone="danger">{error}</Banner>}

      <Panel className="p-4">
        <PanelHeader title="Sending connection" />
        {connection === undefined ? <Skeleton className="h-32 mt-3" /> : (
          <div className="mt-3 flex flex-col gap-3">
            {!connection && <Banner tone="info">No connection configured yet — campaigns send via the built-in mock provider (safe for testing, delivers nowhere real).</Banner>}
            {!canAdmin ? (
              <p className="text-xs text-muted">Only an admin can change the sending connection. Current: {connection ? PROVIDER_LABELS[connection.provider] : 'None (mock fallback)'}</p>
            ) : (
              <>
                <Field label="Provider">
                  <Select value={connForm.provider} onChange={(e) => setConnForm({ ...connForm, provider: e.target.value })}>
                    {Object.entries(PROVIDER_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </Select>
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="From name"><Input value={connForm.fromName} onChange={(e) => setConnForm({ ...connForm, fromName: e.target.value })} /></Field>
                  <Field label="From email"><Input type="email" value={connForm.fromEmail} onChange={(e) => setConnForm({ ...connForm, fromEmail: e.target.value })} /></Field>
                </div>
                <Field label="Reply-to (optional)"><Input type="email" value={connForm.replyTo} onChange={(e) => setConnForm({ ...connForm, replyTo: e.target.value })} /></Field>
                {connForm.provider === 'smtp' && (
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="SMTP host"><Input value={connForm.host} onChange={(e) => setConnForm({ ...connForm, host: e.target.value })} placeholder="email-smtp.us-east-1.amazonaws.com" /></Field>
                    <Field label="Port"><Input type="number" value={connForm.port} onChange={(e) => setConnForm({ ...connForm, port: e.target.value })} placeholder="587" /></Field>
                    <Field label="Username"><Input value={connForm.user} onChange={(e) => setConnForm({ ...connForm, user: e.target.value })} /></Field>
                    <Field label="Password" hint="Leave blank to keep the existing one"><Input type="password" value={connForm.secret} onChange={(e) => setConnForm({ ...connForm, secret: e.target.value })} /></Field>
                  </div>
                )}
                {(connForm.provider === 'sendgrid' || connForm.provider === 'resend') && (
                  <Field label="API key" hint="Leave blank to keep the existing one"><Input type="password" value={connForm.secret} onChange={(e) => setConnForm({ ...connForm, secret: e.target.value })} /></Field>
                )}
                <Button variant="primary" onClick={saveConnection} loading={savingConn} disabled={!connForm.fromName.trim() || !connForm.fromEmail.trim()} className="self-start">Save connection</Button>
              </>
            )}
            <div className="pt-3 border-t border-hairline">
              {testResult && <Banner tone={testResult.ok ? 'success' : 'danger'} icon={testResult.ok ? Check : undefined} className="mb-2">{testResult.message}</Banner>}
              <div className="flex gap-1.5">
                <Input className="h-8 flex-1" placeholder="you@company.com" value={testTo} onChange={(e) => setTestTo(e.target.value)} aria-label="Send connection test to" />
                <Button size="sm" onClick={sendTest} loading={testing} disabled={!testTo.trim()}>Send test</Button>
              </div>
            </div>
          </div>
        )}
      </Panel>

      <Panel className="overflow-hidden">
        <PanelHeader
          title="Sender domains"
          meta="Real SPF/DKIM/DMARC checks"
          action={canAdmin && <Button size="sm" variant="primary" icon={Plus} onClick={() => setDomainOpen(true)}>Add domain</Button>}
        />
        {domains === null ? (
          <div className="p-4"><Skeleton className="h-9" /></div>
        ) : domains.length === 0 ? (
          <EmptyState icon={ShieldAlert} title="No sending domain added" description="Add your sending domain to check its SPF/DKIM/DMARC records." />
        ) : (
          <Table>
            <thead><tr><Th>Domain</Th><Th>SPF</Th><Th>DKIM</Th><Th>DMARC</Th><Th align="right"> </Th></tr></thead>
            <tbody>
              {domains.map((d) => (
                <tr key={d.id}>
                  <Td><span className="font-medium">{d.domain}</span></Td>
                  <Td><VerifiedChip ok={d.spf_verified} /></Td>
                  <Td><VerifiedChip ok={d.dkim_verified} /></Td>
                  <Td><VerifiedChip ok={d.dmarc_verified} /></Td>
                  <Td align="right">{canAdmin && <Button size="sm" icon={RefreshCw} onClick={() => checkDomain(d)} loading={checkingId === d.id}>Check now</Button>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>

      <Panel className="p-4">
        <PanelHeader title="Physical mailing address" />
        <div className="mt-3 flex gap-1.5">
          <Input className="flex-1" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="123 Market St, Bengaluru, India" disabled={!canAdmin} />
          {canAdmin && <Button onClick={saveAddress} icon={addressSaved ? Check : undefined}>{addressSaved ? 'Saved' : 'Save'}</Button>}
        </div>
      </Panel>

      <Modal
        open={domainOpen}
        onClose={() => setDomainOpen(false)}
        title="Add a sending domain"
        footer={<><Button onClick={() => setDomainOpen(false)}>Cancel</Button><Button variant="primary" onClick={addDomain} disabled={!domainForm.domain.trim()}>Add</Button></>}
      >
        <div className="flex flex-col gap-3">
          <Field label="Domain"><Input value={domainForm.domain} onChange={(e) => setDomainForm({ ...domainForm, domain: e.target.value })} placeholder="mail.yourcompany.com" autoFocus /></Field>
          <Field label="DKIM selector (optional)" hint="Your provider's DKIM setup names this, e.g. 'selector1' or a hash from SES"><Input value={domainForm.dkimSelector} onChange={(e) => setDomainForm({ ...domainForm, dkimSelector: e.target.value })} /></Field>
        </div>
      </Modal>
    </div>
  );
}
