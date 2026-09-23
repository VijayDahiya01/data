/**
 * Canonical channel enum -- spec v5 §89.
 *
 * These exact four strings are used in the database, HTTP APIs, signed
 * manifests, queue events and frontend state. §89 explicitly forbids
 * WEB/APP aliases and lowercase variants, so this module is the single
 * definition every layer imports.
 *
 * Eligibility is deliberately NOT encoded here: a channel being listed says
 * nothing about whether an activation may run on it. That is a separate
 * capability/state (§15, §16, §84).
 */
import { z } from 'zod';

export const CHANNELS = ['PARTNER_WEB', 'PARTNER_APP', 'META', 'GOOGLE'] as const;

export type Channel = (typeof CHANNELS)[number];

export const ChannelSchema = z.enum(CHANNELS);

/** Channels Oolix serves itself through the Partner Agent (§12). */
export const PARTNER_OWNED_CHANNELS = [
  'PARTNER_WEB',
  'PARTNER_APP',
] as const satisfies readonly Channel[];

/** Channels that leave the Partner boundary and require an eligibility gate (§15, §16). */
export const EXTERNAL_CHANNELS = ['META', 'GOOGLE'] as const satisfies readonly Channel[];

export function isPartnerOwnedChannel(c: Channel): boolean {
  return (PARTNER_OWNED_CHANNELS as readonly Channel[]).includes(c);
}

export function isExternalChannel(c: Channel): boolean {
  return (EXTERNAL_CHANNELS as readonly Channel[]).includes(c);
}

/**
 * What the Buyer catalogue shows for a channel (§40.5).
 * External channels are never AVAILABLE on the strength of the enum alone --
 * they are CONDITIONAL until the eligibility service clears them (§47, §48).
 */
export const CHANNEL_AVAILABILITY = ['AVAILABLE', 'CONDITIONAL', 'BLOCKED', 'NOT_OFFERED'] as const;
export type ChannelAvailability = (typeof CHANNEL_AVAILABILITY)[number];
export const ChannelAvailabilitySchema = z.enum(CHANNEL_AVAILABILITY);
