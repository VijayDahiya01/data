/**
 * Ask for a password-reset link.
 *
 * The answer never says whether the address has an account -- the API sends
 * the link if there is one and says the same thing either way.
 */
import Link from 'next/link';
import { AuthPage } from '@/components/AuthPage';
import { ForgotPasswordForm } from '@/components/AuthForms';

export const metadata = { title: 'Reset your password — Oolix' };

export default function ForgotPasswordPage() {
  return (
    <AuthPage
      title="Reset your password"
      lead="We will email you a link to choose a new one."
      footer={<Link href="/login">Back to sign in</Link>}
    >
      <ForgotPasswordForm />
    </AuthPage>
  );
}
