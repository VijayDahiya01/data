/**
 * @oolix/manifest-schema -- the signed activation manifest (spec v5 §75).
 *
 * Shared by the control plane (which signs) and, through mirrored Go code,
 * the Partner Agent (which verifies). §11.2: no valid signature, no valid
 * approval and no current policy means no ad and no external upload.
 */
export * from './canonical-json.js';
export * from './manifest.js';
export * from './sign.js';
export * from './keys.js';
