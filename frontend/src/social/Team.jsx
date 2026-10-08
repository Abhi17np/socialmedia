'use client';

import { useEffect, useState } from 'react';
import { RefreshCw, UserPlus, Trash2 } from 'lucide-react';
import { API_BASE } from '../apiBase';

const ROLES = ['viewer', 'member', 'admin', 'owner'];

// Role management is admin+ only on the backend (middleware/tenant.js's
// requireRole) — this page assumes it's only reachable by someone who
// can actually use it (SocialNav hides it otherwise), but every action
// here still goes through the same gate server-side regardless.
function Team({ authFetch, role: myRole }) {
  const [members, setMembers] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({ email: '', password: '', role: 'member' });
  const [adding, setAdding] = useState(false);

  const load = () => {
    authFetch(`${API_BASE}/team/members`)
      .then(res => res.json())
      .then(data => setMembers(data.members || []))
      .catch(err => setError(err.message));
  };

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAdd = async (e) => {
    e.preventDefault();
    setAdding(true);
    setError(null);
    try {
      const res = await authFetch(`${API_BASE}/team/members`, { method: 'POST', body: JSON.stringify(form) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not add teammate.');
      setMembers(prev => [...prev, data.member]);
      setForm({ email: '', password: '', role: 'member' });
    } catch (err) {
      setError(err.message);
    } finally {
      setAdding(false);
    }
  };

  const changeRole = async (member, role) => {
    try {
      const res = await authFetch(`${API_BASE}/team/members/${member.id}`, { method: 'PATCH', body: JSON.stringify({ role }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setMembers(prev => prev.map(m => (m.id === member.id ? data.member : m)));
    } catch (err) {
      setError(err.message);
    }
  };

  const remove = async (member) => {
    if (!window.confirm(`Remove ${member.email} from this workspace?`)) return;
    try {
      const res = await authFetch(`${API_BASE}/team/members/${member.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setMembers(prev => prev.filter(m => m.id !== member.id));
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div>
      <div className="header-container">
        <div className="title-area">
          <h1>Team</h1>
          <p>Everyone with access to this workspace, and what they can do.</p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={load}><RefreshCw size={14} /> Refresh</button>
      </div>

      {error && <p style={{ color: 'var(--accent-danger)', marginBottom: '1rem' }}>{error}</p>}

      <div className="table-section" style={{ marginBottom: '1.5rem' }}>
        <div className="table-header"><strong>Add a teammate</strong></div>
        <form onSubmit={handleAdd} style={{ display: 'flex', gap: '0.75rem', padding: '1rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Email</label>
            <input className="form-control" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Temporary password</label>
            <input className="form-control" type="password" minLength={8} required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Role</label>
            <select className="tool-select" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {ROLES.filter(r => r !== 'owner' || myRole === 'owner').map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <button type="submit" className="btn btn-primary btn-sm" disabled={adding}><UserPlus size={14} /> {adding ? 'Adding…' : 'Add teammate'}</button>
        </form>
      </div>

      <div className="table-section">
        {members === null ? (
          <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>Loading…</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-color)' }}>
                <th style={{ padding: '0.75rem 1rem' }}>Email</th>
                <th style={{ padding: '0.75rem 1rem' }}>Role</th>
                <th style={{ padding: '0.75rem 1rem' }}>Joined</th>
                <th style={{ padding: '0.75rem 1rem' }}></th>
              </tr>
            </thead>
            <tbody>
              {members.map(m => (
                <tr key={m.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <td style={{ padding: '0.75rem 1rem' }}>{m.email}</td>
                  <td style={{ padding: '0.75rem 1rem' }}>
                    <select className="tool-select" value={m.role} onChange={(e) => changeRole(m, e.target.value)}>
                      {ROLES.filter(r => r !== 'owner' || myRole === 'owner').map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </td>
                  <td style={{ padding: '0.75rem 1rem', color: 'var(--text-secondary)' }}>{new Date(m.created_at).toLocaleDateString()}</td>
                  <td style={{ padding: '0.75rem 1rem' }}>
                    <button className="btn btn-secondary btn-sm" onClick={() => remove(m)}><Trash2 size={14} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default Team;
