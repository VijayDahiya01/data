'use client';

/**
 * Form plumbing shared by every screen that writes something.
 *
 * `useActionState` gives progressive enhancement for free: the forms submit and
 * work before hydration, and once hydrated they show pending state and
 * field-level errors from the §77.2 envelope without a page reload.
 */
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import type { ReactNode } from 'react';
import type { ActionState } from '@/lib/actions';

export function SubmitButton({
  children,
  className = 'btn-primary',
  pendingLabel = 'Working…',
}: {
  children: ReactNode;
  className?: string;
  pendingLabel?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending}>
      {pending ? pendingLabel : children}
    </button>
  );
}

export function ActionForm({
  action,
  children,
  className,
}: {
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>;
  children: (state: ActionState) => ReactNode;
  className?: string;
}) {
  const [state, formAction] = useActionState(action, {});

  return (
    <form action={formAction} className={className}>
      {state.error ? (
        <div className="notice notice-danger" role="alert">
          {state.error}
        </div>
      ) : null}
      {children(state)}
    </form>
  );
}

export function FieldError({ state, name }: { state: ActionState; name: string }) {
  const message = state.fieldErrors?.[name];
  return message ? <div className="field-error">{message}</div> : null;
}
