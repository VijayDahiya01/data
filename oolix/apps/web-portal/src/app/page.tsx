/**
 * Entry point.
 *
 * §34 is one application for four personas, so the landing route sends each
 * one to the surface they actually work in rather than showing a shared page
 * that is wrong for everybody.
 */
import { redirect } from 'next/navigation';
import { requireContext, isBuyer, isPartner, isNetworkSponsor, can } from '@/lib/nav-entry';

export default async function Home() {
  const ctx = await requireContext('/');

  // §35.2: a signed-in user with no organization yet is a legitimate state.
  if (!ctx.active_organization) redirect('/organization/new');

  if (isBuyer(ctx)) redirect('/dashboard');
  if (isPartner(ctx)) redirect('/partner');
  if (isNetworkSponsor(ctx)) redirect('/network');
  if (can(ctx, 'admin:operate')) redirect('/admin');

  redirect('/team');
}
