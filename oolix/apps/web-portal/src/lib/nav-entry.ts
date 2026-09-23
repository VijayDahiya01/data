/**
 * Re-export surface for route files.
 *
 * Keeps page components importing one module instead of three, and gives a
 * single place to see what a screen is allowed to reach for.
 */
export { requireContext, errorMessage } from './page';
export { can, canAny, isBuyer, isPartner, isNetworkSponsor } from './context';
export type { MeContext, ActiveOrg, OrgSummary } from './context';
