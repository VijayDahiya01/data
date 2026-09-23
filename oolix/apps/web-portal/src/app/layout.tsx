/**
 * Root layout for the Oolix portal.
 *
 * §34: ONE responsive web application with role-aware navigation for Buyer,
 * Data Partner, VC/Network sponsor and Oolix Admin -- not four codebases. The
 * shell itself is rendered per-route rather than here, because the login and
 * organization-setup screens exist precisely for users who have no navigation
 * yet.
 */
import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Oolix',
  description: 'Privacy-safe partner media activation',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
