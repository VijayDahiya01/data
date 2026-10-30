/**
 * The old "Review and submit" screen.
 *
 * A Buyer now reviews and submits beside the Partners they choose, on screen 3,
 * so an old link lands there; a submitted campaign goes on to its own page.
 */
import { redirect } from 'next/navigation';

export default async function ReviewStepPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/campaigns/${id}/audience`);
}
