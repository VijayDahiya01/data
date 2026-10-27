'use client';

/**
 * §66.2: whether every verified Buyer can find this Partner.
 *
 * Without a listing, a Partner is found only by Buyers in a shared Network or
 * through a marketplace segment. A Partner that connected its data with the
 * setup page publishes capabilities, not segments, so for most of them this
 * switch is the difference between being found and not.
 */
import type { ActionState } from '@/lib/actions';
import { setMarketplaceListing } from '@/lib/actions-audience';
import { ActionForm, SubmitButton } from './FormState';

export function MarketplaceListingForm({
  listed,
  capabilitiesPublished,
}: {
  listed: boolean;
  capabilitiesPublished: boolean;
}) {
  return (
    <ActionForm action={setMarketplaceListing}>
      {(_state: ActionState) => (
        <>
          <p style={{ marginTop: 0 }}>
            {listed ? (
              <>
                <strong>Listed.</strong> Every verified advertiser on Oolix can match their
                audiences against the attributes you publish and ask how many of your customers fit,
                as a range.
              </>
            ) : (
              <>
                <strong>Not listed.</strong> Only advertisers who share a Network with you can find
                you.
              </>
            )}
          </p>
          {!capabilitiesPublished && !listed ? (
            <p className="faint small">
              Nothing is published yet, so a listing would show nothing until your Agent publishes
              its first attributes.
            </p>
          ) : null}
          <p className="faint small">
            Advertisers never see your data or your customers, and you still approve every campaign.
          </p>
          <input type="hidden" name="listed" value={listed ? 'false' : 'true'} />
          <SubmitButton className={listed ? 'btn-secondary' : 'btn-primary'}>
            {listed ? 'Stop listing' : 'List me for all verified advertisers'}
          </SubmitButton>
        </>
      )}
    </ActionForm>
  );
}
