/**
 * React bindings -- spec v5 §68.
 *
 * Mirrors the integration example in §68 exactly:
 *
 *   <OolixProvider decisionEndpoint="/internal/ads/decision" requestTimeoutMs={150}>
 *     <OolixAdSlot placementId="booking_success_offer"
 *                  fallback={<PartnerHouseOffer />}
 *                  onError={(e) => console.warn("ad-slot", e.code)} />
 *   </OolixProvider>
 *
 * React is an optional peer dependency: `./client.js` works standalone for
 * Partners on other frameworks.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { DEFAULT_REQUEST_TIMEOUT_MS, reportEvent, requestDecision } from './client.js';
import type { AdCreative, DecisionRequestContext, SdkError } from './types.js';

export interface OolixProviderConfig {
  /** Partner backend endpoint. Never an Oolix URL (§68). */
  decisionEndpoint: string;
  /** Optional Partner endpoint for impression/click telemetry. */
  eventEndpoint?: string;
  requestTimeoutMs?: number;
}

const OolixContext = createContext<OolixProviderConfig | null>(null);

export function OolixProvider({
  children,
  ...config
}: OolixProviderConfig & { children: ReactNode }) {
  const value = useMemo(
    () => ({ ...config, requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS }),
    [config.decisionEndpoint, config.eventEndpoint, config.requestTimeoutMs],
  );
  return <OolixContext.Provider value={value}>{children}</OolixContext.Provider>;
}

export interface OolixAdSlotProps {
  placementId: string;
  context?: DecisionRequestContext;
  /** Rendered on NO_AD, timeout or any error (§43 fallback, §57). */
  fallback?: ReactNode;
  onError?: (error: SdkError) => void;
  /** Override the provider's timeout for one slot. */
  requestTimeoutMs?: number;
  /** Supply custom markup instead of the built-in renderer. */
  render?: (creative: AdCreative, onClick: () => void) => ReactNode;
  className?: string;
}

export function OolixAdSlot({
  placementId,
  context,
  fallback = null,
  onError,
  requestTimeoutMs,
  render,
  className,
}: OolixAdSlotProps) {
  const config = useContext(OolixContext);
  const [creative, setCreative] = useState<AdCreative | null>(null);
  const [activationId, setActivationId] = useState<string | null>(null);
  const [settled, setSettled] = useState(false);
  const impressionSent = useRef(false);

  if (!config) {
    throw new Error('<OolixAdSlot> must be rendered inside <OolixProvider>.');
  }

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    void requestDecision({
      decisionEndpoint: config.decisionEndpoint,
      placementId,
      ...(context ? { context } : {}),
      requestTimeoutMs: requestTimeoutMs ?? config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      signal: controller.signal,
    }).then((result) => {
      if (!active) return;
      if (result.error) onError?.(result.error);
      if (result.decision.decision === 'SHOW') {
        setCreative(result.decision.creative);
        setActivationId(result.decision.activation_id);
      }
      setSettled(true);
    });

    return () => {
      active = false;
      controller.abort();
    };
    // `context` is intentionally compared by identity: a Partner passing an
    // inline object literal would otherwise refetch on every render.
  }, [config.decisionEndpoint, placementId, requestTimeoutMs]);

  useEffect(() => {
    if (!creative || !activationId || impressionSent.current) return;
    impressionSent.current = true;
    if (config.eventEndpoint) {
      reportEvent(config.eventEndpoint, {
        event: 'impression',
        activation_id: activationId,
        placement_id: placementId,
      });
    }
  }, [creative, activationId, config.eventEndpoint, placementId]);

  // Render nothing until the decision settles, so the slot does not flash
  // fallback content and then replace it.
  if (!settled) return null;
  if (!creative) return <>{fallback}</>;

  const handleClick = () => {
    if (config.eventEndpoint && activationId) {
      reportEvent(config.eventEndpoint, {
        event: 'click',
        activation_id: activationId,
        placement_id: placementId,
      });
    }
  };

  if (render) return <>{render(creative, handleClick)}</>;

  return (
    <a
      className={className}
      href={creative.destination_url}
      onClick={handleClick}
      // The destination is a Buyer domain; noopener/noreferrer prevents the
      // landing page from reaching back into the Partner's window, and stops
      // the Partner's URL leaking in the Referer header.
      rel="noopener noreferrer sponsored"
      target="_blank"
      data-oolix-placement={placementId}
    >
      {creative.asset_url ? (
        <img
          src={creative.asset_url}
          alt={creative.headline ?? ''}
          width={creative.width ?? undefined}
          height={creative.height ?? undefined}
          loading="lazy"
        />
      ) : null}
      {creative.headline ? <span data-oolix-headline>{creative.headline}</span> : null}
      {creative.body ? <span data-oolix-body>{creative.body}</span> : null}
      {creative.cta ? <span data-oolix-cta>{creative.cta}</span> : null}
      {creative.legal_disclaimer ? (
        <small data-oolix-disclaimer>{creative.legal_disclaimer}</small>
      ) : null}
    </a>
  );
}
