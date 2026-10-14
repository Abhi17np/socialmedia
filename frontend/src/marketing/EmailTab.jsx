'use client';

import { useState } from 'react';
import { FileText, Megaphone, Settings } from 'lucide-react';
import { PillSelect } from '../ui';
import EmailTemplatesSection from './EmailTemplatesSection';
import EmailCampaignsSection from './EmailCampaignsSection';
import EmailSettingsSection from './EmailSettingsSection';

const SECTIONS = [
  { key: 'campaigns', label: 'Campaigns', icon: Megaphone },
  { key: 'templates', label: 'Templates', icon: FileText },
  { key: 'settings', label: 'Settings', icon: Settings }
];

/** Email marketing's own sub-navigation within Marketing Hub's "Email" tab — same shape as WhatsAppHub's internal TABS, kept local state rather than a query param since drilling further than tab=email isn't needed for deep-linking today. */
export default function EmailTab({ authFetch, canManage, canAdmin }) {
  const [section, setSection] = useState('campaigns');

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-1.5">
        <PillSelect value={section} onChange={(e) => setSection(e.target.value)} aria-label="Email section">
          {SECTIONS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </PillSelect>
      </div>
      {section === 'campaigns' && <EmailCampaignsSection authFetch={authFetch} canManage={canManage} canAdmin={canAdmin} />}
      {section === 'templates' && <EmailTemplatesSection authFetch={authFetch} canManage={canManage} canAdmin={canAdmin} />}
      {section === 'settings' && <EmailSettingsSection authFetch={authFetch} canAdmin={canAdmin} />}
    </div>
  );
}
