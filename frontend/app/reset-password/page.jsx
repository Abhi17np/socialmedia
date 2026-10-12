import { Suspense } from 'react';
import ResetPassword from '../../src/auth/ResetPassword';

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPassword />
    </Suspense>
  );
}
