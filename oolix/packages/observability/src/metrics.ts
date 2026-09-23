/**
 * Metric names and alert thresholds -- spec v5 §25, §58, §78.2, §103.
 *
 * Names live in code, not only in a dashboard config, so that the emitter and
 * the alert rule cannot drift apart. §78.2's thresholds are encoded alongside
 * them for the same reason.
 */

/** Canonical metric names. Dot-separated, lower case. */
export const METRICS = {
  // Control plane (§78.2)
  apiRequestDuration: 'oolix.api.request.duration_ms',
  apiRequestErrors: 'oolix.api.request.errors',
  queueLagSeconds: 'oolix.queue.oldest_message_age_seconds',
  queueDlqDepth: 'oolix.queue.dlq.depth',
  reportBatchLagSeconds: 'oolix.reporting.batch_lag_seconds',

  // Partner Agent (§25, §58)
  agentHeartbeatAgeSeconds: 'oolix.agent.heartbeat_age_seconds',
  agentConfigAgeSeconds: 'oolix.agent.config_age_seconds',
  adDecisionDuration: 'oolix.agent.ad_decision.duration_ms',
  segmentLookupDuration: 'oolix.agent.segment_lookup.duration_ms',
  noAdReason: 'oolix.agent.no_ad.count',
  connectorHealth: 'oolix.agent.connector.health',

  // External channels (§58)
  channelSyncFailures: 'oolix.channel.sync.failures',
  externalResourceAgeSeconds: 'oolix.channel.resource.non_terminal_age_seconds',

  // Outcomes and money (§58)
  crmCallbackFailures: 'oolix.lead.crm_callback.failures',
  billingVariance: 'oolix.billing.reconciliation.variance',
  killSwitchEvents: 'oolix.security.kill_switch.events',
  redactionHits: 'oolix.security.log_redaction.hits',
} as const;

export type MetricName = (typeof METRICS)[keyof typeof METRICS];

/**
 * §78.2 alert thresholds. `forSeconds` is how long the condition must hold
 * before firing -- without it, a single slow request pages someone.
 */
export interface AlertRule {
  metric: MetricName;
  description: string;
  threshold: number;
  comparison: 'gt' | 'lt';
  forSeconds: number;
  severity: 'critical' | 'warning';
}

export const ALERT_RULES: readonly AlertRule[] = [
  {
    metric: METRICS.agentHeartbeatAgeSeconds,
    description: 'Partner Agent heartbeat is stale (§78.2: age > 5 min)',
    threshold: 300,
    comparison: 'gt',
    forSeconds: 0,
    severity: 'critical',
  },
  {
    metric: METRICS.agentConfigAgeSeconds,
    description: 'Control sync lag (§78.2: warn > 5 min, critical > 15 min)',
    threshold: 300,
    comparison: 'gt',
    forSeconds: 0,
    severity: 'warning',
  },
  {
    metric: METRICS.agentConfigAgeSeconds,
    description: 'Control sync critically stale; Agent must stop new activity (§75)',
    threshold: 900,
    comparison: 'gt',
    forSeconds: 0,
    severity: 'critical',
  },
  {
    metric: METRICS.adDecisionDuration,
    description: 'Ad decision p95 above budget (§78.2: p95 > 100 ms for 10 min)',
    threshold: 100,
    comparison: 'gt',
    forSeconds: 600,
    severity: 'warning',
  },
  {
    metric: METRICS.segmentLookupDuration,
    description: 'Segment lookup p95 above budget (§78.2: p95 > 30 ms for 10 min)',
    threshold: 30,
    comparison: 'gt',
    forSeconds: 600,
    severity: 'warning',
  },
  {
    metric: METRICS.apiRequestErrors,
    description: 'Oolix API 5xx rate (§78.2: > 2% for 5 min)',
    threshold: 0.02,
    comparison: 'gt',
    forSeconds: 300,
    severity: 'critical',
  },
  {
    metric: METRICS.queueLagSeconds,
    description: 'Queue lag (§78.2: oldest message > 2 min for 10 min)',
    threshold: 120,
    comparison: 'gt',
    forSeconds: 600,
    severity: 'warning',
  },
  {
    metric: METRICS.queueDlqDepth,
    description: 'Any production DLQ message (§74, §78.2)',
    threshold: 0,
    comparison: 'gt',
    forSeconds: 0,
    severity: 'critical',
  },
  {
    metric: METRICS.reportBatchLagSeconds,
    description: 'Report batch lag (§78.2: > 5 min)',
    threshold: 300,
    comparison: 'gt',
    forSeconds: 0,
    severity: 'warning',
  },
  {
    metric: METRICS.externalResourceAgeSeconds,
    description: 'External audience stuck non-terminal (§78.2, §103: > 30 min)',
    threshold: 1800,
    comparison: 'gt',
    forSeconds: 0,
    severity: 'warning',
  },
  {
    metric: METRICS.killSwitchEvents,
    description: 'Kill switch activated -- immediate audit notification (§78.2)',
    threshold: 0,
    comparison: 'gt',
    forSeconds: 0,
    severity: 'critical',
  },
  {
    metric: METRICS.redactionHits,
    description:
      'A field on the redaction list reached a log. Architecturally this should be ' +
      'impossible for partner_user_id (§3), so investigate the source.',
    threshold: 0,
    comparison: 'gt',
    forSeconds: 0,
    severity: 'critical',
  },
];

/** §103 performance budgets, in milliseconds. */
export const PERFORMANCE_BUDGETS_MS = {
  campaignWriteP95: 500,
  catalogueSearchP95: 300,
  partnerApprovalWriteP95: 300,
  dashboard30DayP95: 2000,
  adDecisionP95: 100,
  segmentLookupP95: 30,
  /** §68: the SDK abandons the request at this point and renders fallback. */
  sdkHardTimeout: 150,
} as const;
