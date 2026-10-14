import PreferenceCenter from '../../../src/marketing/PreferenceCenter';

export default async function PreferencesPage({ params }) {
  const { token } = await params;
  return <PreferenceCenter token={token} />;
}
