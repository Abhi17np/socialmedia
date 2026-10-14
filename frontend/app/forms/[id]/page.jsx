import HostedLeadForm from '../../../src/marketing/HostedLeadForm';

export default async function HostedFormPage({ params }) {
  const { id } = await params;
  return <HostedLeadForm formId={id} />;
}
