/**
 * The old Partner matches page.
 *
 * Matches and reach estimates now sit together on the audience page, asked for
 * automatically, so an old link lands there.
 */
import { redirect } from 'next/navigation';

export default async function PartnerMatchesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/audiences/${id}`);
}
