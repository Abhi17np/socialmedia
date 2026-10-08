export const SOCIAL_API_BASE = `${import.meta.env.VITE_API_BASE || 'http://localhost:5000/api/v1'}/social`;

export const PLATFORM_LABELS = {
  youtube: 'YouTube',
  google_business: 'Google Business Profile',
  facebook: 'Facebook',
  instagram: 'Instagram',
  pinterest: 'Pinterest',
  linkedin: 'LinkedIn',
  whatsapp: 'WhatsApp',
  x: 'X'
};

// Brand colors — used for the little platform badge on Inbox avatars and
// the per-account bars on the Social Dashboard. Not part of the
// dataviz-validated chart palette (CATEGORICAL_PALETTE in App.jsx) since
// these never appear as adjacent chart series — each platform appears at
// most once per row/bar, so brand recognizability wins over series
// discriminability here.
export const PLATFORM_COLORS = {
  facebook: '#1877f2',
  instagram: '#e1306c',
  youtube: '#ff0000',
  google_business: '#4285f4',
  linkedin: '#0a66c2',
  whatsapp: '#25d366',
  pinterest: '#e60023',
  x: '#0f1419'
};

// backend/social/adapters/index.js is the real source of truth; this
// list just drives which platforms Connect Accounts/Inbox offer. Phase 1:
// youtube, google_business. Phase 2 adds facebook, instagram. Phase 3
// adds linkedin (personal-profile posting only — see
// backend/social/adapters/linkedin.js). Phase 4 adds whatsapp — note
// Composer.jsx deliberately does NOT use this list; it excludes whatsapp
// explicitly, since it's messaging-only and has no publish() (see
// backend/social/adapters/whatsapp.js). x stays out until its external
// approval clears.
export const AVAILABLE_PLATFORMS = ['youtube', 'google_business', 'facebook', 'instagram', 'linkedin', 'whatsapp'];
