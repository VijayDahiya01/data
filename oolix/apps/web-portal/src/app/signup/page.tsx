/**
 * Create an account (§35.1).
 *
 * Step one of two: the person, then (after confirming their email and signing
 * in) their organization at /organization/new (§35.2).
 */
import Link from 'next/link';
import { AuthPage } from '@/components/AuthPage';
import { SignUpForm } from '@/components/AuthForms';

export const metadata = { title: 'Create an account — Oolix' };

export default function SignUpPage() {
  return (
    <AuthPage
      title="Create your Oolix account"
      lead="Next, confirm your email. Then set up your organization."
      footer={
        <>
          Already have an account? <Link href="/login">Sign in</Link>
        </>
      }
    >
      <SignUpForm />
    </AuthPage>
  );
}
