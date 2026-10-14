import ConfirmSubscription from '../../../../src/marketing/ConfirmSubscription';

export default async function ConfirmSubscriptionPage({ params }) {
  const { token } = await params;
  return <ConfirmSubscription token={token} />;
}
