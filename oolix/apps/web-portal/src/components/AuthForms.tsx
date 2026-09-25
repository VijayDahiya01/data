'use client';

/**
 * Sign-up, sign-in and recovery forms (§35.1).
 *
 * Every form posts to a server action; nothing here touches a token. Browser
 * autofill attributes are set deliberately: `current-password` on sign-in,
 * `new-password` wherever a password is being chosen, so password managers
 * fill the right one and offer to save the new one.
 */
import { useActionState, useState } from 'react';
import type { ActionState } from '@/lib/actions';
import {
  acceptInvitation,
  changePassword,
  confirmEmail,
  requestPasswordReset,
  resendVerification,
  resetPassword,
  signIn,
  signUp,
  type AuthState,
} from '@/lib/actions-auth';
import { ActionForm, FieldError, SubmitButton } from './FormState';

const PASSWORD_HINT =
  'At least 12 characters. A few unrelated words make a strong one. Common and leaked passwords are refused.';

/** Countries Oolix sells into first; the API accepts any two-letter code. */
const COUNTRIES = [
  ['IN', 'India'],
  ['SG', 'Singapore'],
  ['AE', 'United Arab Emirates'],
  ['GB', 'United Kingdom'],
  ['US', 'United States'],
  ['AU', 'Australia'],
  ['ID', 'Indonesia'],
  ['MY', 'Malaysia'],
  ['SA', 'Saudi Arabia'],
  ['DE', 'Germany'],
] as const;

/**
 * Lets a person check what they typed (ASVS 2.1.12). Long passphrases are
 * exactly the ones worth reading back, and a masked-only field pushes people
 * towards short passwords they can type blind.
 */
function ShowPassword({ shown, onChange }: { shown: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="field-hint" style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
      <input
        type="checkbox"
        checked={shown}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 'auto' }}
      />
      Show password
    </label>
  );
}

function PasswordFields({
  state,
  name = 'password',
  label = 'Password',
  required = true,
}: {
  state: ActionState;
  name?: string;
  label?: string;
  required?: boolean;
}) {
  const [shown, setShown] = useState(false);
  return (
    <>
      <div className="field">
        <label htmlFor={name}>{label}</label>
        <input
          id={name}
          name={name}
          type={shown ? 'text' : 'password'}
          autoComplete="new-password"
          required={required}
          minLength={12}
          maxLength={128}
        />
        <div className="field-hint">{PASSWORD_HINT}</div>
        <FieldError state={state} name={name} />
      </div>
      <div className="field">
        <label htmlFor="confirm_password">Type it again</label>
        <input
          id="confirm_password"
          name="confirm_password"
          type={shown ? 'text' : 'password'}
          autoComplete="new-password"
          required={required}
        />
        <FieldError state={state} name="confirm_password" />
        <ShowPassword shown={shown} onChange={setShown} />
      </div>
    </>
  );
}

/**
 * Holds its own state rather than using ActionForm, because the "email me a
 * new link" offer is a second form -- and a form may not sit inside another.
 */
export function SignInForm({ returnTo }: { returnTo: string }) {
  const [state, formAction] = useActionState<AuthState, FormData>(signIn, {});
  const [shown, setShown] = useState(false);
  return (
    <>
      <form action={formAction}>
        {state.error ? (
          <div className="notice notice-danger" role="alert">
            {state.error}
          </div>
        ) : null}
        <input type="hidden" name="return_to" value={returnTo} />
        <div className="field">
          <label htmlFor="email">Work email</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            defaultValue={state.email}
          />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type={shown ? 'text' : 'password'}
            autoComplete="current-password"
            required
          />
          <ShowPassword shown={shown} onChange={setShown} />
        </div>
        <SubmitButton pendingLabel="Signing in…">Sign in</SubmitButton>
      </form>
      {state.unverified && state.email ? <ResendVerificationForm email={state.email} /> : null}
    </>
  );
}

export function ResendVerificationForm({ email }: { email: string }) {
  return (
    <ActionForm action={resendVerification}>
      {(state: ActionState) =>
        state.ok ? (
          <p className="muted" role="status">
            A new link is on its way to {email}.
          </p>
        ) : (
          <>
            <input type="hidden" name="email" value={email} />
            <SubmitButton className="btn-secondary" pendingLabel="Sending…">
              Email me a new link
            </SubmitButton>
          </>
        )
      }
    </ActionForm>
  );
}

export function SignUpForm() {
  return (
    <ActionForm action={signUp}>
      {(state: ActionState) => {
        const s = state as AuthState;
        if (s.ok) {
          return (
            <div role="status">
              <p style={{ marginTop: 0 }}>
                <strong>Check your email.</strong> We sent a link to {s.email}. Open it to confirm
                your address, then sign in.
              </p>
              <p className="muted">
                Nothing after a few minutes? Check the spam folder, or sign in and ask for a new
                link.
              </p>
            </div>
          );
        }
        return (
          <>
            <div className="field">
              <label htmlFor="name">Full name</label>
              <input
                id="name"
                name="name"
                autoComplete="name"
                required
                minLength={2}
                maxLength={100}
              />
              <FieldError state={state} name="name" />
            </div>
            <div className="field">
              <label htmlFor="email">Work email</label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                placeholder="you@company.com"
              />
              <FieldError state={state} name="email" />
            </div>
            <PasswordFields state={state} />
            <div className="field">
              <label htmlFor="country">Country</label>
              <select id="country" name="country" required defaultValue="IN">
                {COUNTRIES.map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
              <FieldError state={state} name="country" />
            </div>
            <div className="field">
              <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
                <input type="checkbox" name="accept_terms" required style={{ width: 'auto' }} />
                <span>I accept the Oolix Terms of Service and Privacy Notice.</span>
              </label>
              <FieldError state={state} name="accept_terms" />
            </div>
            <SubmitButton pendingLabel="Creating your account…">Create account</SubmitButton>
          </>
        );
      }}
    </ActionForm>
  );
}

/**
 * A button, not an automatic confirmation. Corporate mail scanners open every
 * link in a message to check it; if merely opening the page confirmed the
 * address, the scanner would spend the link before the person ever saw it.
 */
export function ConfirmEmailForm({ token }: { token: string }) {
  return (
    <ActionForm action={confirmEmail}>
      {() => (
        <>
          <input type="hidden" name="token" value={token} />
          <SubmitButton pendingLabel="Confirming…">Confirm my email address</SubmitButton>
        </>
      )}
    </ActionForm>
  );
}

export function ForgotPasswordForm() {
  return (
    <ActionForm action={requestPasswordReset}>
      {(state: ActionState) =>
        state.ok ? (
          <p role="status" style={{ margin: 0 }}>
            If an account uses that address, a reset link is on its way. It works for 30 minutes.
          </p>
        ) : (
          <>
            <div className="field">
              <label htmlFor="email">Work email</label>
              <input id="email" name="email" type="email" autoComplete="email" required />
              <FieldError state={state} name="email" />
            </div>
            <SubmitButton pendingLabel="Sending…">Email me a reset link</SubmitButton>
          </>
        )
      }
    </ActionForm>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  return (
    <ActionForm action={resetPassword}>
      {(state: ActionState) => (
        <>
          <input type="hidden" name="token" value={token} />
          <PasswordFields state={state} label="New password" />
          <SubmitButton pendingLabel="Saving…">Set new password</SubmitButton>
        </>
      )}
    </ActionForm>
  );
}

export function AcceptInvitationForm({ token }: { token: string }) {
  return (
    <ActionForm action={acceptInvitation}>
      {(state: ActionState) => (
        <>
          <input type="hidden" name="token" value={token} />
          <div className="field">
            <label htmlFor="name">Your name</label>
            <input id="name" name="name" autoComplete="name" minLength={2} maxLength={100} />
            <FieldError state={state} name="name" />
          </div>
          <PasswordFields state={state} label="Choose a password" required={false} />
          <div className="field-hint" style={{ marginBottom: '0.75rem' }}>
            Already have an Oolix account? Leave the password empty — you will sign in with the one
            you have.
          </div>
          <SubmitButton pendingLabel="Joining…">Accept invitation</SubmitButton>
        </>
      )}
    </ActionForm>
  );
}

export function ChangePasswordForm() {
  return (
    <ActionForm action={changePassword}>
      {(state: ActionState) => (
        <>
          {state.ok ? (
            <div className="notice" role="status">
              Password changed. Every other signed-in session has been signed out.
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="current_password">Current password</label>
            <input
              id="current_password"
              name="current_password"
              type="password"
              autoComplete="current-password"
              required
            />
            <FieldError state={state} name="current_password" />
          </div>
          <PasswordFields state={state} name="new_password" label="New password" />
          <SubmitButton pendingLabel="Saving…">Change password</SubmitButton>
        </>
      )}
    </ActionForm>
  );
}
