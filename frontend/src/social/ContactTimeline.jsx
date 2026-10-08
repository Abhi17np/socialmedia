'use client';

import React, { useEffect, useState } from 'react';
import { X, MessageSquare, AtSign } from 'lucide-react';
import { SOCIAL_API_BASE, PLATFORM_LABELS, PLATFORM_COLORS } from './api';

// The selling feature, made visible: one scrollable history of every
// message and mention from this one person, across every connected
// platform — reading GET /social/contacts/:id/timeline, which resolves
// contact_id the same way the WhatsApp webhook and the inbound pollers do
// (see backend/lib/contacts.js). Without this panel, that unification
// only existed in the database; nobody could actually see it.
function ContactTimeline({ contactId, authFetch, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!contactId) return;
    setData(null);
    setError(null);
    authFetch(`${SOCIAL_API_BASE}/contacts/${contactId}/timeline`)
      .then(res => res.json().then(body => ({ ok: res.ok, body })))
      .then(({ ok, body }) => {
        if (!ok) throw new Error(body.error || 'Could not load this contact.');
        setData(body);
      })
      .catch(err => setError(err.message));
  }, [contactId, authFetch]);

  if (!contactId) return null;

  return (
    <div className="timeline-overlay" onClick={onClose}>
      <div className="timeline-panel" onClick={(e) => e.stopPropagation()}>
        <div className="timeline-panel-header">
          <div>
            <h2>{data ? (data.contact.display_name || 'Unnamed contact') : 'Loading…'}</h2>
            {data && (data.contact.phone || data.contact.email) && (
              <p className="timeline-panel-sub">{[data.contact.phone, data.contact.email].filter(Boolean).join(' · ')}</p>
            )}
          </div>
          <button className="btn btn-secondary btn-sm" onClick={onClose}><X size={16} /></button>
        </div>

        {error && <p style={{ color: 'var(--accent-danger)', padding: '0 1.25rem' }}>{error}</p>}

        {!data && !error && <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>Loading…</div>}

        {data && (
          <div className="timeline-list">
            {data.timeline.length === 0 && (
              <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>No history yet for this contact.</div>
            )}
            {data.timeline.map((entry, i) => (
              <div className="timeline-entry" key={i}>
                <div className="timeline-entry-badge" style={{ background: PLATFORM_COLORS[entry.platform] || 'var(--text-muted)' }}>
                  {entry.kind === 'mention' ? <AtSign size={12} /> : <MessageSquare size={12} />}
                </div>
                <div className="timeline-entry-body">
                  <div className="timeline-entry-top">
                    <span className="timeline-entry-platform">{PLATFORM_LABELS[entry.platform] || entry.platform}</span>
                    <span className="timeline-entry-date">{new Date(entry.at).toLocaleString()}</span>
                  </div>
                  <p className="timeline-entry-text">
                    {entry.kind === 'message' && entry.direction === 'outbound' && <strong>You: </strong>}
                    {entry.text}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default ContactTimeline;
