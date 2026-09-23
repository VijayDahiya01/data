/**
 * The vocabulary of a channel eligibility decision -- spec v5 §47.5, §48.4.
 *
 * Kept separate from the service so the Agent-facing manifest, the portal and
 * the audit trail can all name the same reason. An operator reading "BLOCKED"
 * with no further detail has to guess; every failure here carries the check
 * that produced it.
 */

/** One named condition from §47.5 / §48.4. */
export interface EligibilityCheck {
  /** Stable identifier. Appears in audit events, so it must not be reworded. */
  id: string;
  /** What was being checked, in the words an operator would use. */
  description: string;
  passed: boolean;
  /** Why it failed, or what satisfied it. Never contains a credential. */
  detail: string;
}

export interface EligibilityVerdict {
  eligible: boolean;
  provider: 'META' | 'GOOGLE';
  checks: EligibilityCheck[];
  /**
   * The failing checks, in evaluation order. Empty when eligible.
   *
   * Plural on purpose: reporting only the first failure sends an operator
   * round the loop once per problem, and connecting an ad account is slow
   * enough that one round trip per missing scope is a bad experience.
   */
  blocking: EligibilityCheck[];
  /** One line suitable for Activation.statusReason. */
  summary: string;
}

export function verdictFrom(
  provider: 'META' | 'GOOGLE',
  checks: EligibilityCheck[],
): EligibilityVerdict {
  const blocking = checks.filter((c) => !c.passed);
  const eligible = blocking.length === 0 && checks.length > 0;
  return {
    eligible,
    provider,
    checks,
    blocking,
    summary: eligible
      ? `${provider} eligibility passed (${checks.length} checks).`
      : `${provider} not eligible: ${blocking.map((c) => c.id).join(', ')}.`,
  };
}
