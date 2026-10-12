'use client';

import WhatsAppHub from '../../../src/whatsapp/WhatsAppHub';
import { useAuth } from '../../../src/AuthContext';

export default function WhatsAppPage() {
  const { authFetch, role } = useAuth();
  return <WhatsAppHub authFetch={authFetch} role={role} />;
}
