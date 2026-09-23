-- CreateEnum
CREATE TYPE "OrganizationType" AS ENUM ('BUYER', 'DATA_PARTNER', 'BUYER_AND_PARTNER', 'NETWORK_SPONSOR', 'AGENCY');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('SIGNUP_STARTED', 'EMAIL_VERIFIED', 'ORGANIZATION_CREATED', 'BUSINESS_VERIFICATION_PENDING', 'BUSINESS_VERIFIED', 'ROLE_ONBOARDING', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING_EMAIL_VERIFICATION', 'ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'REMOVED');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('BUYER_ADMIN', 'BUYER_OPERATOR', 'PARTNER_ADMIN', 'PARTNER_SECURITY_ADMIN', 'PARTNER_CAMPAIGN_APPROVER', 'NETWORK_ADMIN', 'FINANCE', 'ANALYST', 'OOLIX_ADMIN');

-- CreateEnum
CREATE TYPE "NetworkMode" AS ENUM ('PRIVATE', 'CURATED', 'MARKETPLACE');

-- CreateEnum
CREATE TYPE "NetworkMembershipStatus" AS ENUM ('INVITED', 'ACTIVE', 'DECLINED', 'REMOVED');

-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('PARTNER_WEB', 'PARTNER_APP', 'META', 'GOOGLE');

-- CreateEnum
CREATE TYPE "ChannelProvider" AS ENUM ('META', 'GOOGLE');

-- CreateEnum
CREATE TYPE "Objective" AS ENUM ('QUALIFIED_LEADS', 'CONVERSIONS', 'CLICKS', 'AWARENESS');

-- CreateEnum
CREATE TYPE "PricingModel" AS ENUM ('CPM', 'CPC', 'CPL', 'CPQL', 'FIXED', 'HYBRID');

-- CreateEnum
CREATE TYPE "Surface" AS ENUM ('web', 'ios', 'android', 'react_native', 'flutter', 'backend_native');

-- CreateEnum
CREATE TYPE "PlacementFormat" AS ENUM ('banner', 'native_card', 'carousel', 'inline', 'modal');

-- CreateEnum
CREATE TYPE "PlacementStatus" AS ENUM ('DRAFT', 'ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "PlacementFallback" AS ENUM ('NO_AD', 'HOUSE_CONTENT');

-- CreateEnum
CREATE TYPE "SegmentStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'SUSPENDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ReachBucket" AS ENUM ('UNDER_10K', '10K_50K', '50K_100K', '100K_250K', '250K_500K', '500K_1M', 'OVER_1M');

-- CreateEnum
CREATE TYPE "RefreshFrequency" AS ENUM ('15m', 'hourly', '6h', 'daily', 'weekly');

-- CreateEnum
CREATE TYPE "ConsentEligibility" AS ENUM ('ELIGIBLE', 'MIXED', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "ListingVisibility" AS ENUM ('PRIVATE_NETWORK', 'CURATED', 'MARKETPLACE');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'PARTIALLY_APPROVED', 'READY', 'PARTIALLY_LIVE', 'LIVE', 'PAUSED', 'ENDED', 'SETTLED');

-- CreateEnum
CREATE TYPE "PartnerRequestStatus" AS ENUM ('DRAFT', 'PARTNER_REVIEW', 'CHANGE_REQUESTED', 'APPROVED', 'REJECTED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ActivationStatus" AS ENUM ('PENDING_CHANNEL_CHECK', 'READY', 'SYNCING', 'LIVE', 'PAUSED', 'FAILED', 'ENDING', 'ENDED');

-- CreateEnum
CREATE TYPE "ExternalSyncStatus" AS ENUM ('NOT_STARTED', 'PREPARING', 'UPLOADING', 'PROCESSING', 'READY', 'FAILED', 'REMOVING', 'REMOVED');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'CALCULATED', 'REVIEWED', 'APPROVED', 'PAID', 'DISPUTED', 'ADJUSTED', 'REJECTED_DISPUTE');

-- CreateEnum
CREATE TYPE "LeadState" AS ENUM ('UNREDEEMED', 'RECEIVED', 'VALID', 'QUALIFIED', 'CONVERTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PartnerDecision" AS ENUM ('APPROVE', 'REQUEST_CHANGE', 'REJECT', 'REVOKE');

-- CreateEnum
CREATE TYPE "CreativeType" AS ENUM ('IMAGE', 'NATIVE_CARD');

-- CreateEnum
CREATE TYPE "CreativeStatus" AS ENUM ('UPLOADING', 'READY', 'REJECTED');

-- CreateEnum
CREATE TYPE "CreativeDecisionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('ACTIVE', 'REVOKED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "ChannelConnectionStatus" AS ENUM ('NOT_CONNECTED', 'PENDING', 'CONNECTED', 'EXPIRED', 'REVOKED', 'ERROR');

-- CreateEnum
CREATE TYPE "PartnerReadiness" AS ENUM ('PROFILE_INCOMPLETE', 'POLICY_PENDING', 'AGENT_PENDING', 'CONNECTOR_PENDING', 'SEGMENTS_PENDING', 'PLACEMENTS_PENDING', 'TEST_CAMPAIGN_PENDING', 'READY_FOR_CAMPAIGNS', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "FinancialEventType" AS ENUM ('MEDIA_ACCRUAL', 'OUTCOME_ACCRUAL', 'PLATFORM_FEE', 'PARTNER_PAYOUT_BASIS', 'ADJUSTMENT', 'TAX');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'PAID', 'VOID', 'REVIEW_REQUIRED');

-- CreateEnum
CREATE TYPE "KillSwitchScope" AS ENUM ('AGENT', 'PLACEMENT', 'ACTIVATION', 'CHANNEL', 'PARTNER_ALL');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('PASS', 'REVIEW_REQUIRED', 'RESOLVED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "auth_subject" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING_EMAIL_VERIFICATION',
    "terms_version" TEXT,
    "accepted_at" TIMESTAMPTZ(6),
    "country" CHAR(2),
    "mfa_enrolled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "type" "OrganizationType" NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "verification_status" "VerificationStatus" NOT NULL DEFAULT 'SIGNUP_STARTED',
    "country" CHAR(2) NOT NULL,
    "industry" TEXT,
    "tax_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_members" (
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "Role" NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "invited_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "organization_members_pkey" PRIMARY KEY ("org_id","user_id","role")
);

-- CreateTable
CREATE TABLE "networks" (
    "id" UUID NOT NULL,
    "sponsor_org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "mode" "NetworkMode" NOT NULL,
    "policy_version" TEXT NOT NULL DEFAULT 'N-1',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "networks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "network_memberships" (
    "network_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "status" "NetworkMembershipStatus" NOT NULL DEFAULT 'INVITED',
    "role_flags" JSONB NOT NULL DEFAULT '{}',
    "invited_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "joined_at" TIMESTAMPTZ(6),

    CONSTRAINT "network_memberships_pkey" PRIMARY KEY ("network_id","org_id")
);

-- CreateTable
CREATE TABLE "partner_profiles" (
    "org_id" UUID NOT NULL,
    "readiness_status" "PartnerReadiness" NOT NULL DEFAULT 'PROFILE_INCOMPLETE',
    "active_policy_id" UUID,
    "payout_profile_id" UUID,
    "approval_sla_days" INTEGER NOT NULL DEFAULT 7,
    "min_publishable_reach" INTEGER NOT NULL DEFAULT 1000,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "partner_profiles_pkey" PRIMARY KEY ("org_id")
);

-- CreateTable
CREATE TABLE "partner_policies" (
    "id" UUID NOT NULL,
    "partner_org_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "allowed_categories" TEXT[],
    "blocked_categories" TEXT[],
    "blocked_advertisers" TEXT[],
    "geographies" TEXT[],
    "prohibited_use" TEXT[],
    "commercial_policy" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buyer_profiles" (
    "org_id" UUID NOT NULL,
    "billing_profile_id" UUID,
    "default_brand_id" UUID,
    "onboarding_status" TEXT NOT NULL DEFAULT 'PROFILE_INCOMPLETE',
    "crm_webhook_url" TEXT,
    "crm_api_key_hash" BYTEA,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "buyer_profiles_pkey" PRIMARY KEY ("org_id")
);

-- CreateTable
CREATE TABLE "brands" (
    "id" UUID NOT NULL,
    "buyer_org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "logo_uri" TEXT,
    "category" TEXT NOT NULL,
    "website" TEXT NOT NULL,
    "landing_domain" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_profiles" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "legal_name" TEXT NOT NULL,
    "address" JSONB NOT NULL,
    "tax_id" TEXT,
    "currency" CHAR(3) NOT NULL,
    "payment_method_ref" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "segments" (
    "id" UUID NOT NULL,
    "partner_org_id" UUID NOT NULL,
    "internal_key" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "safe_metadata" JSONB NOT NULL,
    "category" TEXT NOT NULL,
    "geographies" TEXT[],
    "reach_bucket" "ReachBucket" NOT NULL,
    "reach_bucket_published_at" TIMESTAMPTZ(6),
    "freshness_at" TIMESTAMPTZ(6),
    "refresh_frequency" "RefreshFrequency" NOT NULL,
    "consent_eligibility" "ConsentEligibility" NOT NULL DEFAULT 'ELIGIBLE',
    "allowed_channels" "Channel"[],
    "allowed_categories" TEXT[],
    "blocked_categories" TEXT[],
    "status" "SegmentStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "segment_offers" (
    "id" UUID NOT NULL,
    "segment_id" UUID NOT NULL,
    "network_id" UUID,
    "pricing_model" "PricingModel" NOT NULL,
    "unit_price_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "visibility" "ListingVisibility" NOT NULL DEFAULT 'PRIVATE_NETWORK',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "segment_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "placements" (
    "id" UUID NOT NULL,
    "partner_org_id" UUID NOT NULL,
    "placement_key" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "surface" "Surface" NOT NULL,
    "format" "PlacementFormat" NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "context_tags" TEXT[],
    "allowed_categories" TEXT[],
    "blocked_categories" TEXT[],
    "max_frequency_default" INTEGER NOT NULL DEFAULT 2,
    "fallback" "PlacementFallback" NOT NULL DEFAULT 'NO_AD',
    "policy" JSONB NOT NULL DEFAULT '{}',
    "status" "PlacementStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "placements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" UUID NOT NULL,
    "buyer_org_id" UUID NOT NULL,
    "brand_id" UUID,
    "name" VARCHAR(120) NOT NULL,
    "objective" "Objective" NOT NULL,
    "category" TEXT NOT NULL,
    "purpose_id" TEXT NOT NULL,
    "budget_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "start_at" TIMESTAMPTZ(6) NOT NULL,
    "end_at" TIMESTAMPTZ(6) NOT NULL,
    "geographies" TEXT[],
    "landing_url" TEXT,
    "lead_definition" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "submitted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creatives" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "CreativeType" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creatives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creative_versions" (
    "id" UUID NOT NULL,
    "creative_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "type" "CreativeType" NOT NULL,
    "asset_uri" TEXT,
    "thumbnail_uri" TEXT,
    "mime_type" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "file_size_bytes" INTEGER,
    "headline" TEXT,
    "body" TEXT,
    "cta" TEXT,
    "destination_url" TEXT,
    "legal_disclaimer" TEXT,
    "status" "CreativeStatus" NOT NULL DEFAULT 'UPLOADING',
    "content_sha256" BYTEA,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creative_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_requests" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "partner_org_id" UUID NOT NULL,
    "segment_id" UUID NOT NULL,
    "request_version" INTEGER NOT NULL DEFAULT 1,
    "status" "PartnerRequestStatus" NOT NULL DEFAULT 'DRAFT',
    "snapshot_json" JSONB NOT NULL,
    "audience_expansion_allowed" BOOLEAN NOT NULL DEFAULT false,
    "submitted_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "extension_count" SMALLINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "partner_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_requests" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "channel" "Channel" NOT NULL,
    "placement_ids" TEXT[],
    "allocation_minor" BIGINT NOT NULL,
    "frequency_cap" JSONB NOT NULL,
    "creative_version_ids" TEXT[],

    CONSTRAINT "channel_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "decision" "PartnerDecision" NOT NULL,
    "decision_version" INTEGER NOT NULL,
    "reason" TEXT,
    "policy_version" TEXT NOT NULL,
    "request_version" INTEGER NOT NULL,
    "approved_channels" "Channel"[],
    "approved_placement_ids" TEXT[],
    "approved_budget_minor" BIGINT,
    "approved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_creative_decisions" (
    "id" UUID NOT NULL,
    "partner_request_id" UUID NOT NULL,
    "creative_version_id" UUID NOT NULL,
    "status" "CreativeDecisionStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "reviewed_at" TIMESTAMPTZ(6),

    CONSTRAINT "partner_creative_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activations" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "channel" "Channel" NOT NULL,
    "placement_id" UUID,
    "status" "ActivationStatus" NOT NULL DEFAULT 'PENDING_CHANNEL_CHECK',
    "manifest_version" INTEGER NOT NULL DEFAULT 0,
    "budget_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status_reason" TEXT,
    "started_at" TIMESTAMPTZ(6),
    "ended_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "activations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manifests" (
    "id" UUID NOT NULL,
    "activation_id" UUID NOT NULL,
    "manifest_version" INTEGER NOT NULL,
    "jws" TEXT NOT NULL,
    "kid" TEXT NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL,
    "config_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "payload_sha256" BYTEA NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manifests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agents" (
    "id" UUID NOT NULL,
    "partner_org_id" UUID NOT NULL,
    "client_id" VARCHAR(120) NOT NULL,
    "public_jwk" JSONB NOT NULL,
    "version" VARCHAR(32) NOT NULL,
    "capabilities" "Channel"[],
    "status" "AgentStatus" NOT NULL DEFAULT 'ACTIVE',
    "last_heartbeat_at" TIMESTAMPTZ(6),
    "last_config_version" INTEGER NOT NULL DEFAULT 0,
    "config_age_seconds" INTEGER,
    "previous_public_jwk" JSONB,
    "key_rotated_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_bootstrap_tokens" (
    "id" UUID NOT NULL,
    "partner_org_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "generated_by" UUID NOT NULL,
    "generated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "agent_bootstrap_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_connections" (
    "id" UUID NOT NULL,
    "partner_org_id" UUID NOT NULL,
    "provider" "ChannelProvider" NOT NULL,
    "account_ids" JSONB NOT NULL,
    "status" "ChannelConnectionStatus" NOT NULL DEFAULT 'NOT_CONNECTED',
    "scopes" JSONB NOT NULL DEFAULT '[]',
    "capability_flags" JSONB NOT NULL DEFAULT '{}',
    "expires_at" TIMESTAMPTZ(6),
    "last_checked_at" TIMESTAMPTZ(6),
    "status_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "channel_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_resources" (
    "id" UUID NOT NULL,
    "activation_id" UUID NOT NULL,
    "provider" "ChannelProvider" NOT NULL,
    "audience_id" TEXT,
    "external_campaign_id" TEXT,
    "resource_status" "ExternalSyncStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "audience_version" INTEGER NOT NULL DEFAULT 1,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "last_synced_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "external_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attribution_tokens" (
    "token_hash" BYTEA NOT NULL,
    "activation_id" UUID NOT NULL,
    "partner_org_id" UUID NOT NULL,
    "placement_id" UUID,
    "creative_version_id" UUID,
    "issued_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "first_clicked_at" TIMESTAMPTZ(6),
    "lead_state" "LeadState" NOT NULL DEFAULT 'UNREDEEMED',
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "attribution_tokens_pkey" PRIMARY KEY ("token_hash")
);

-- CreateTable
CREATE TABLE "lead_events" (
    "id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "buyer_org_id" UUID NOT NULL,
    "crm_event_id" TEXT NOT NULL,
    "status" "LeadState" NOT NULL,
    "previous_status" "LeadState",
    "event_time" TIMESTAMPTZ(6) NOT NULL,
    "lead_reference" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aggregate_metrics" (
    "activation_id" UUID NOT NULL,
    "bucket_start" TIMESTAMPTZ(6) NOT NULL,
    "impressions" BIGINT NOT NULL DEFAULT 0,
    "clicks" BIGINT NOT NULL DEFAULT 0,
    "spend_minor" BIGINT NOT NULL DEFAULT 0,
    "leads" BIGINT NOT NULL DEFAULT 0,
    "qualified_leads" BIGINT NOT NULL DEFAULT 0,
    "conversions" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "aggregate_metrics_pkey" PRIMARY KEY ("activation_id","bucket_start")
);

-- CreateTable
CREATE TABLE "delivery_batches" (
    "id" UUID NOT NULL,
    "partner_org_id" UUID NOT NULL,
    "agent_id" UUID,
    "batch_id" TEXT NOT NULL,
    "counter_count" INTEGER NOT NULL,
    "accepted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "correlation_id" TEXT,

    CONSTRAINT "delivery_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliations" (
    "id" UUID NOT NULL,
    "activation_id" UUID NOT NULL,
    "bucket_date" DATE NOT NULL,
    "agent_count" BIGINT NOT NULL,
    "central_count" BIGINT NOT NULL,
    "difference_abs" BIGINT NOT NULL,
    "tolerance" BIGINT NOT NULL,
    "status" "ReconciliationStatus" NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commercial_terms" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "pricing_model" "PricingModel" NOT NULL,
    "unit_price_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "platform_fee_bps" INTEGER NOT NULL DEFAULT 1000,
    "max_budget_minor" BIGINT NOT NULL,
    "tax_treatment" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commercial_terms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_events" (
    "id" UUID NOT NULL,
    "activation_id" UUID NOT NULL,
    "event_type" "FinancialEventType" NOT NULL,
    "quantity" BIGINT NOT NULL DEFAULT 0,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "source_ref" TEXT NOT NULL,
    "period_start" TIMESTAMPTZ(6),
    "period_end" TIMESTAMPTZ(6),
    "adjusts_event_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "financial_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "buyer_org_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "subtotal_minor" BIGINT NOT NULL,
    "tax_minor" BIGINT NOT NULL DEFAULT 0,
    "total_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "period_start" TIMESTAMPTZ(6) NOT NULL,
    "period_end" TIMESTAMPTZ(6) NOT NULL,
    "issued_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payouts" (
    "id" UUID NOT NULL,
    "partner_org_id" UUID NOT NULL,
    "activation_id" UUID NOT NULL,
    "eligible_amount_minor" BIGINT NOT NULL,
    "adjustment_minor" BIGINT NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "dispute_reason" TEXT,
    "period_start" TIMESTAMPTZ(6) NOT NULL,
    "period_end" TIMESTAMPTZ(6) NOT NULL,
    "calculated_at" TIMESTAMPTZ(6),
    "paid_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "actor" TEXT NOT NULL,
    "actor_type" TEXT NOT NULL DEFAULT 'USER',
    "org_id" UUID,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "correlation_id" TEXT,
    "timestamp" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "recipient_user_id" UUID,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "key" TEXT NOT NULL,
    "org_id" UUID,
    "endpoint" TEXT NOT NULL,
    "request_hash" BYTEA NOT NULL,
    "response_status" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "kill_switches" (
    "id" UUID NOT NULL,
    "partner_org_id" UUID NOT NULL,
    "scope" "KillSwitchScope" NOT NULL,
    "target_id" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT,
    "activated_by" UUID NOT NULL,
    "activated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMPTZ(6),

    CONSTRAINT "kill_switches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_auth_subject_key" ON "users"("auth_subject");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "organizations_type_verification_status_idx" ON "organizations"("type", "verification_status");

-- CreateIndex
CREATE INDEX "organizations_domain_idx" ON "organizations"("domain");

-- CreateIndex
CREATE INDEX "organization_members_user_id_idx" ON "organization_members"("user_id");

-- CreateIndex
CREATE INDEX "networks_sponsor_org_id_idx" ON "networks"("sponsor_org_id");

-- CreateIndex
CREATE INDEX "network_memberships_org_id_status_idx" ON "network_memberships"("org_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "partner_policies_partner_org_id_version_key" ON "partner_policies"("partner_org_id", "version");

-- CreateIndex
CREATE INDEX "brands_buyer_org_id_idx" ON "brands"("buyer_org_id");

-- CreateIndex
CREATE INDEX "billing_profiles_org_id_idx" ON "billing_profiles"("org_id");

-- CreateIndex
CREATE INDEX "segments_status_reach_bucket_idx" ON "segments"("status", "reach_bucket");

-- CreateIndex
CREATE INDEX "segments_partner_org_id_status_idx" ON "segments"("partner_org_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "segments_partner_org_id_internal_key_key" ON "segments"("partner_org_id", "internal_key");

-- CreateIndex
CREATE INDEX "segment_offers_visibility_idx" ON "segment_offers"("visibility");

-- CreateIndex
CREATE UNIQUE INDEX "segment_offers_segment_id_network_id_key" ON "segment_offers"("segment_id", "network_id");

-- CreateIndex
CREATE INDEX "placements_partner_org_id_status_idx" ON "placements"("partner_org_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "placements_partner_org_id_placement_key_key" ON "placements"("partner_org_id", "placement_key");

-- CreateIndex
CREATE INDEX "campaigns_buyer_org_id_status_idx" ON "campaigns"("buyer_org_id", "status");

-- CreateIndex
CREATE INDEX "campaigns_start_at_end_at_idx" ON "campaigns"("start_at", "end_at");

-- CreateIndex
CREATE INDEX "creatives_campaign_id_idx" ON "creatives"("campaign_id");

-- CreateIndex
CREATE INDEX "creative_versions_campaign_id_status_idx" ON "creative_versions"("campaign_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "creative_versions_creative_id_version_key" ON "creative_versions"("creative_id", "version");

-- CreateIndex
CREATE INDEX "partner_requests_partner_org_id_status_idx" ON "partner_requests"("partner_org_id", "status");

-- CreateIndex
CREATE INDEX "partner_requests_status_expires_at_idx" ON "partner_requests"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "partner_requests_campaign_id_partner_org_id_request_version_key" ON "partner_requests"("campaign_id", "partner_org_id", "request_version");

-- CreateIndex
CREATE UNIQUE INDEX "channel_requests_request_id_channel_key" ON "channel_requests"("request_id", "channel");

-- CreateIndex
CREATE INDEX "approvals_request_id_idx" ON "approvals"("request_id");

-- CreateIndex
CREATE UNIQUE INDEX "approvals_request_id_decision_version_key" ON "approvals"("request_id", "decision_version");

-- CreateIndex
CREATE UNIQUE INDEX "partner_creative_decisions_partner_request_id_creative_vers_key" ON "partner_creative_decisions"("partner_request_id", "creative_version_id");

-- CreateIndex
CREATE INDEX "activations_request_id_idx" ON "activations"("request_id");

-- CreateIndex
CREATE INDEX "activations_status_idx" ON "activations"("status");

-- CreateIndex
CREATE INDEX "manifests_config_expires_at_idx" ON "manifests"("config_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "manifests_activation_id_manifest_version_key" ON "manifests"("activation_id", "manifest_version");

-- CreateIndex
CREATE UNIQUE INDEX "agents_client_id_key" ON "agents"("client_id");

-- CreateIndex
CREATE INDEX "agents_partner_org_id_status_idx" ON "agents"("partner_org_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "agent_bootstrap_tokens_token_hash_key" ON "agent_bootstrap_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "agent_bootstrap_tokens_partner_org_id_idx" ON "agent_bootstrap_tokens"("partner_org_id");

-- CreateIndex
CREATE INDEX "agent_bootstrap_tokens_expires_at_idx" ON "agent_bootstrap_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "channel_connections_partner_org_id_provider_key" ON "channel_connections"("partner_org_id", "provider");

-- CreateIndex
CREATE INDEX "external_resources_resource_status_updated_at_idx" ON "external_resources"("resource_status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "external_resources_activation_id_provider_key" ON "external_resources"("activation_id", "provider");

-- CreateIndex
CREATE INDEX "attribution_tokens_activation_id_idx" ON "attribution_tokens"("activation_id");

-- CreateIndex
CREATE INDEX "attribution_tokens_expires_at_idx" ON "attribution_tokens"("expires_at");

-- CreateIndex
CREATE INDEX "lead_events_token_hash_idx" ON "lead_events"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "lead_events_buyer_org_id_crm_event_id_key" ON "lead_events"("buyer_org_id", "crm_event_id");

-- CreateIndex
CREATE INDEX "aggregate_metrics_bucket_start_idx" ON "aggregate_metrics"("bucket_start");

-- CreateIndex
CREATE INDEX "delivery_batches_accepted_at_idx" ON "delivery_batches"("accepted_at");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_batches_partner_org_id_batch_id_key" ON "delivery_batches"("partner_org_id", "batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliations_activation_id_bucket_date_key" ON "reconciliations"("activation_id", "bucket_date");

-- CreateIndex
CREATE UNIQUE INDEX "commercial_terms_request_id_key" ON "commercial_terms"("request_id");

-- CreateIndex
CREATE INDEX "financial_events_activation_id_created_at_idx" ON "financial_events"("activation_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "financial_events_activation_id_event_type_source_ref_key" ON "financial_events"("activation_id", "event_type", "source_ref");

-- CreateIndex
CREATE INDEX "invoices_buyer_org_id_status_idx" ON "invoices"("buyer_org_id", "status");

-- CreateIndex
CREATE INDEX "payouts_partner_org_id_status_idx" ON "payouts"("partner_org_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "payouts_activation_id_period_start_period_end_key" ON "payouts"("activation_id", "period_start", "period_end");

-- CreateIndex
CREATE INDEX "audit_events_org_id_timestamp_idx" ON "audit_events"("org_id", "timestamp");

-- CreateIndex
CREATE INDEX "audit_events_entity_type_entity_id_idx" ON "audit_events"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "notifications_org_id_created_at_idx" ON "notifications"("org_id", "created_at");

-- CreateIndex
CREATE INDEX "idempotency_records_expires_at_idx" ON "idempotency_records"("expires_at");

-- CreateIndex
CREATE INDEX "kill_switches_partner_org_id_active_idx" ON "kill_switches"("partner_org_id", "active");

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "networks" ADD CONSTRAINT "networks_sponsor_org_id_fkey" FOREIGN KEY ("sponsor_org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "network_memberships" ADD CONSTRAINT "network_memberships_network_id_fkey" FOREIGN KEY ("network_id") REFERENCES "networks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "network_memberships" ADD CONSTRAINT "network_memberships_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_profiles" ADD CONSTRAINT "partner_profiles_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_policies" ADD CONSTRAINT "partner_policies_partner_org_id_fkey" FOREIGN KEY ("partner_org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buyer_profiles" ADD CONSTRAINT "buyer_profiles_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brands" ADD CONSTRAINT "brands_buyer_org_id_fkey" FOREIGN KEY ("buyer_org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_profiles" ADD CONSTRAINT "billing_profiles_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "segments" ADD CONSTRAINT "segments_partner_org_id_fkey" FOREIGN KEY ("partner_org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "segment_offers" ADD CONSTRAINT "segment_offers_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "segments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "segment_offers" ADD CONSTRAINT "segment_offers_network_id_fkey" FOREIGN KEY ("network_id") REFERENCES "networks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "placements" ADD CONSTRAINT "placements_partner_org_id_fkey" FOREIGN KEY ("partner_org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_buyer_org_id_fkey" FOREIGN KEY ("buyer_org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creatives" ADD CONSTRAINT "creatives_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creative_versions" ADD CONSTRAINT "creative_versions_creative_id_fkey" FOREIGN KEY ("creative_id") REFERENCES "creatives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creative_versions" ADD CONSTRAINT "creative_versions_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_requests" ADD CONSTRAINT "partner_requests_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_requests" ADD CONSTRAINT "partner_requests_partner_org_id_fkey" FOREIGN KEY ("partner_org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_requests" ADD CONSTRAINT "partner_requests_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "segments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_requests" ADD CONSTRAINT "channel_requests_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "partner_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "partner_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_creative_decisions" ADD CONSTRAINT "partner_creative_decisions_partner_request_id_fkey" FOREIGN KEY ("partner_request_id") REFERENCES "partner_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_creative_decisions" ADD CONSTRAINT "partner_creative_decisions_creative_version_id_fkey" FOREIGN KEY ("creative_version_id") REFERENCES "creative_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activations" ADD CONSTRAINT "activations_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "partner_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activations" ADD CONSTRAINT "activations_placement_id_fkey" FOREIGN KEY ("placement_id") REFERENCES "placements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manifests" ADD CONSTRAINT "manifests_activation_id_fkey" FOREIGN KEY ("activation_id") REFERENCES "activations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_partner_org_id_fkey" FOREIGN KEY ("partner_org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_bootstrap_tokens" ADD CONSTRAINT "agent_bootstrap_tokens_partner_org_id_fkey" FOREIGN KEY ("partner_org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_bootstrap_tokens" ADD CONSTRAINT "agent_bootstrap_tokens_generated_by_fkey" FOREIGN KEY ("generated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_partner_org_id_fkey" FOREIGN KEY ("partner_org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_resources" ADD CONSTRAINT "external_resources_activation_id_fkey" FOREIGN KEY ("activation_id") REFERENCES "activations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attribution_tokens" ADD CONSTRAINT "attribution_tokens_activation_id_fkey" FOREIGN KEY ("activation_id") REFERENCES "activations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attribution_tokens" ADD CONSTRAINT "attribution_tokens_partner_org_id_fkey" FOREIGN KEY ("partner_org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attribution_tokens" ADD CONSTRAINT "attribution_tokens_placement_id_fkey" FOREIGN KEY ("placement_id") REFERENCES "placements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attribution_tokens" ADD CONSTRAINT "attribution_tokens_creative_version_id_fkey" FOREIGN KEY ("creative_version_id") REFERENCES "creative_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_events" ADD CONSTRAINT "lead_events_token_hash_fkey" FOREIGN KEY ("token_hash") REFERENCES "attribution_tokens"("token_hash") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_events" ADD CONSTRAINT "lead_events_buyer_org_id_fkey" FOREIGN KEY ("buyer_org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aggregate_metrics" ADD CONSTRAINT "aggregate_metrics_activation_id_fkey" FOREIGN KEY ("activation_id") REFERENCES "activations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_batches" ADD CONSTRAINT "delivery_batches_partner_org_id_fkey" FOREIGN KEY ("partner_org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_batches" ADD CONSTRAINT "delivery_batches_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_activation_id_fkey" FOREIGN KEY ("activation_id") REFERENCES "activations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commercial_terms" ADD CONSTRAINT "commercial_terms_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "partner_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_events" ADD CONSTRAINT "financial_events_activation_id_fkey" FOREIGN KEY ("activation_id") REFERENCES "activations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_buyer_org_id_fkey" FOREIGN KEY ("buyer_org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_partner_org_id_fkey" FOREIGN KEY ("partner_org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_activation_id_fkey" FOREIGN KEY ("activation_id") REFERENCES "activations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kill_switches" ADD CONSTRAINT "kill_switches_partner_org_id_fkey" FOREIGN KEY ("partner_org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
