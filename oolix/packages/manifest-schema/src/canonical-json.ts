/**
 * Canonical JSON serialization -- spec v5 §75.
 *
 * "Manifest format is canonical JSON serialized with sorted keys and signed
 * as JWS ES256."
 *
 * Why this matters: the Partner Agent verifies a signature over bytes. If the
 * control plane and the Agent disagree by even one byte -- a different key
 * order, a different number rendering -- every manifest fails verification and
 * no ad serves. So serialization is defined once, here, and both sides use it.
 *
 * Rules:
 *   - Object keys sorted by UTF-16 code unit (JavaScript's default sort),
 *     applied recursively.
 *   - Arrays keep their order; order is meaningful (e.g. placement priority).
 *   - `undefined` properties are omitted; explicit `null` is preserved.
 *   - Numbers must be finite. NaN/Infinity are rejected rather than silently
 *     becoming null, because a corrupted budget must never be signable.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

function canonicalize(value: unknown, path: string): JsonValue {
  if (value === null) return null;

  const t = typeof value;

  if (t === 'string' || t === 'boolean') return value as string | boolean;

  if (t === 'number') {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new TypeError(`non-finite number at ${path}: ${String(n)}`);
    }
    return n;
  }

  if (t === 'bigint') {
    // Money is BIGINT minor units in the database (§73). Serializing it as a
    // JSON number would silently lose precision past 2^53, so callers must
    // convert to string or a safe number before signing.
    throw new TypeError(
      `bigint at ${path}: convert to a string or safe number before signing (spec §73)`,
    );
  }

  if (Array.isArray(value)) {
    return value.map((v, i) => canonicalize(v, `${path}[${i}]`));
  }

  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(obj).sort()) {
      const v = obj[key];
      if (v === undefined) continue;
      out[key] = canonicalize(v, `${path}.${key}`);
    }
    return out;
  }

  throw new TypeError(`unserializable value at ${path}: ${t}`);
}

/** Serialize to canonical JSON text (sorted keys, no insignificant whitespace). */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value, '$'));
}

/** Canonical JSON as UTF-8 bytes -- what actually gets signed. */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJsonStringify(value));
}
