/**
 * The emails the sign-in flows send.
 *
 * Plain wording, one link each, and a text part alongside the HTML: a message
 * that renders only as HTML is a spam signal, and some corporate clients strip
 * HTML entirely. Anything a user typed -- a name, an organization name -- is
 * escaped before it reaches the HTML part.
 */

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Paragraphs, with one of them allowed to be the call-to-action link. */
function render(subject: string, paragraphs: Array<string | { link: string; label: string }>) {
  const text = paragraphs
    .map((p) => (typeof p === 'string' ? p : `${p.label}:\n${p.link}`))
    .concat('— Oolix')
    .join('\n\n');

  const html = [
    '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.5;color:#1f2933;max-width:560px">',
    ...paragraphs.map((p) =>
      typeof p === 'string'
        ? `<p>${escapeHtml(p)}</p>`
        : `<p><a href="${escapeHtml(p.link)}" style="display:inline-block;padding:10px 18px;background:#1f4fd1;color:#fff;border-radius:6px;text-decoration:none">${escapeHtml(p.label)}</a></p>` +
          `<p style="font-size:13px;color:#52606d">Or paste this address into your browser:<br>${escapeHtml(p.link)}</p>`,
    ),
    '<p>— Oolix</p>',
    '</div>',
  ].join('\n');

  return { subject, text, html };
}

export function verifyEmailMessage(name: string, link: string): RenderedEmail {
  return render('Confirm your email for Oolix', [
    `Hi ${name},`,
    'Confirm your email address to finish creating your Oolix account.',
    { link, label: 'Confirm email address' },
    'The link works once and expires in 24 hours. If you did not sign up for Oolix, ignore this email — nothing is active until the address is confirmed.',
  ]);
}

export function invitationMessage(
  name: string,
  orgName: string | null,
  link: string,
): RenderedEmail {
  const who = orgName ?? 'An organization';
  return render(orgName ? `You're invited to ${orgName} on Oolix` : "You're invited to Oolix", [
    `Hi ${name},`,
    `${who} has invited you to work with them on Oolix, the privacy-safe partner media platform.`,
    { link, label: 'Accept the invitation' },
    'The link works once and expires in 7 days.',
  ]);
}

export function passwordResetMessage(name: string, link: string): RenderedEmail {
  return render('Reset your Oolix password', [
    `Hi ${name},`,
    'Someone — hopefully you — asked to reset the password for your Oolix account.',
    { link, label: 'Choose a new password' },
    'The link works once and expires in 30 minutes. If you did not ask for this, ignore this email; your password has not changed.',
  ]);
}

export function passwordChangedMessage(name: string, forgotLink: string): RenderedEmail {
  return render('Your Oolix password was changed', [
    `Hi ${name},`,
    'The password for your Oolix account was just changed, and every other signed-in session was signed out.',
    'If this was not you, reset your password now and tell your organization’s administrator.',
    { link: forgotLink, label: 'Reset my password' },
  ]);
}

export function accountExistsMessage(
  name: string,
  signInLink: string,
  forgotLink: string,
): RenderedEmail {
  return render('Someone tried to create an Oolix account with your email', [
    `Hi ${name},`,
    'Someone tried to sign up for Oolix with this email address, which already has an account. If that was you, sign in instead:',
    { link: signInLink, label: 'Sign in' },
    `Forgotten your password? Reset it at ${forgotLink}. If it was not you, there is nothing you need to do.`,
  ]);
}

export function accountLockedMessage(name: string, forgotLink: string): RenderedEmail {
  return render('Oolix sign-in paused after failed attempts', [
    `Hi ${name},`,
    'After 10 failed attempts, sign-in to your Oolix account is paused for 15 minutes.',
    'If this was you, wait and try again, or reset your password. If it was not you, resetting your password is the safest step.',
    { link: forgotLink, label: 'Reset my password' },
  ]);
}
