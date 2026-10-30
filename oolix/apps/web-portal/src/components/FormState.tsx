'use client';

/**
 * Form plumbing shared by every screen that writes something.
 *
 * `useActionState` gives progressive enhancement for free: the forms submit and
 * work before hydration, and once hydrated they show pending state and
 * field-level errors from the §77.2 envelope without a page reload.
 *
 * Every form also says what is missing before it goes anywhere (CheckedForm).
 * The browser checks required fields itself, but says so in a bubble that is
 * easy to miss -- and cannot point at a field inside a closed "More options"
 * at all, so pressing the button just did nothing. Its checks are kept; the
 * telling is done here, under the button that was pressed.
 */
import { useActionState, useEffect, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import type { FormEvent, ReactNode } from 'react';
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

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/** What a person calls a field: its label, else its aria-label, else its name. */
function fieldName(el: Field): string {
  const label = el.labels?.[0]?.textContent?.trim();
  return label || el.getAttribute('aria-label') || el.name || 'a field';
}

/** "A", "A and B", "A, B and C". */
function listOf(names: string[]): string {
  return names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** "Fill in Campaign name and Image to continue." */
function whatIsMissing(invalid: Field[]): string {
  const empty = [...new Set(invalid.filter((el) => el.validity.valueMissing).map(fieldName))];
  const wrong = [
    ...new Set(
      invalid
        .filter((el) => !el.validity.valueMissing)
        .map((el) => `${fieldName(el)} (${el.validationMessage})`),
    ),
  ];
  const parts = [
    empty.length ? `fill in ${listOf(empty)}` : '',
    wrong.length ? `correct ${listOf(wrong)}` : '',
  ].filter(Boolean);
  const text = `${parts.join(', and ')} to continue.`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * A <form> that names what is still missing, outlines it, opens the section
 * it is in and moves to it -- before anything is sent.
 */
export function CheckedForm({
  action,
  className,
  validate,
  children,
}: {
  action: (fd: FormData) => void | Promise<void>;
  className?: string;
  /** A rule the browser cannot check itself: what is wrong, or null to go on. */
  validate?: (form: HTMLFormElement) => string | null;
  children: ReactNode;
}) {
  const ref = useRef<HTMLFormElement>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const form = ref.current;
    if (!form) return;
    let gathering = false;

    // The browser fires `invalid` at each field still wrong and then refuses
    // to submit. Its own bubble is suppressed; once every field has fired,
    // they are gathered and said together.
    const onInvalid = (e: Event) => {
      e.preventDefault();
      if (gathering) return;
      gathering = true;
      queueMicrotask(() => {
        gathering = false;
        const invalid = Array.from(form.elements).filter(
          (el): el is Field => 'validity' in el && !(el as Field).validity.valid,
        );
        for (const el of invalid) {
          el.closest('details')?.setAttribute('open', '');
          el.setAttribute('aria-invalid', 'true');
        }
        invalid[0]?.focus();
        setMessage(invalid.length > 0 ? whatIsMissing(invalid) : null);
      });
    };

    // A field stops being marked as soon as it is right.
    const onEdit = (e: Event) => {
      const el = e.target as Field;
      if (el.getAttribute?.('aria-invalid') !== 'true' || !el.validity?.valid) return;
      el.removeAttribute('aria-invalid');
      if (!form.querySelector('[aria-invalid="true"]')) setMessage(null);
    };

    form.addEventListener('invalid', onInvalid, true);
    form.addEventListener('input', onEdit);
    form.addEventListener('change', onEdit);
    return () => {
      form.removeEventListener('invalid', onInvalid, true);
      form.removeEventListener('input', onEdit);
      form.removeEventListener('change', onEdit);
    };
  }, []);

  // Reached only once the browser's own checks pass. Preventing the default
  // here stops the action as well.
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    const problem = validate?.(e.currentTarget) ?? null;
    setMessage(problem);
    if (problem) e.preventDefault();
  };

  return (
    <form ref={ref} action={action} className={className} onSubmit={onSubmit}>
      {children}
      {message ? (
        <div className="notice notice-warn form-missing" role="alert">
          {message}
        </div>
      ) : null}
    </form>
  );
}

export function ActionForm({
  action,
  children,
  className,
  validate,
}: {
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>;
  children: (state: ActionState) => ReactNode;
  className?: string;
  validate?: (form: HTMLFormElement) => string | null;
}) {
  const [state, formAction] = useActionState(action, {});
  const errorRef = useRef<HTMLDivElement>(null);

  // A refusal from the server is shown above the form, and the button that
  // was pressed is below it: bring it into view.
  useEffect(() => {
    if (state.error) errorRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [state]);

  return (
    <CheckedForm action={formAction} className={className} validate={validate}>
      {state.error ? (
        <div ref={errorRef} className="notice notice-danger" role="alert">
          {state.error}
        </div>
      ) : null}
      {children(state)}
    </CheckedForm>
  );
}

export function FieldError({ state, name }: { state: ActionState; name: string }) {
  const message = state.fieldErrors?.[name];
  return message ? <div className="field-error">{message}</div> : null;
}
