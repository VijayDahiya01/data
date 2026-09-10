-- CreateEnum
CREATE TYPE "AttributeCategory" AS ENUM ('DEMOGRAPHIC', 'GEOGRAPHY', 'COMMERCE', 'PAYMENT_BEHAVIOUR', 'TRAVEL', 'ENGAGEMENT');

-- CreateEnum
CREATE TYPE "AttributeDataType" AS ENUM ('NUMBER', 'ENUM', 'BOOLEAN', 'ID');

-- CreateEnum
CREATE TYPE "RuleOperator" AS ENUM ('EQ', 'IN', 'LTE', 'GTE', 'BETWEEN');

-- CreateEnum
CREATE TYPE "PolicyClass" AS ENUM ('GENERAL', 'RESTRICTED', 'SENSITIVE');

-- CreateEnum
CREATE TYPE "AudienceGroupStatus" AS ENUM ('DRAFT', 'READY', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AudienceVersionStatus" AS ENUM ('DRAFT', 'READY', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "MatchStatus" AS ENUM ('COMPATIBLE', 'INCOMPATIBLE');

-- CreateEnum
CREATE TYPE "ReachEstimateStatus" AS ENUM ('REQUESTED', 'PROCESSING', 'READY', 'BELOW_THRESHOLD', 'UNAVAILABLE', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "CapabilityStatus" AS ENUM ('ACTIVE', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "TargetingSource" AS ENUM ('AUDIENCE_GROUP', 'PREBUILT_SEGMENT');

-- DropForeignKey
ALTER TABLE "partner_requests" DROP CONSTRAINT "partner_requests_segment_id_fkey";

-- AlterTable
ALTER TABLE "partner_requests" ADD COLUMN     "audience_group_id" UUID,
ADD COLUMN     "audience_rule_hash" CHAR(64),
ADD COLUMN     "audience_version" INTEGER,
ADD COLUMN     "reach_estimate_id" UUID,
ADD COLUMN     "targeting_source" "TargetingSource" NOT NULL DEFAULT 'PREBUILT_SEGMENT',
ALTER COLUMN "segment_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "attribute_definitions" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "description" TEXT,
    "category" "AttributeCategory" NOT NULL,
    "data_type" "AttributeDataType" NOT NULL,
    "operators_json" JSONB NOT NULL,
    "allowed_values_json" JSONB,
    "min_value" INTEGER,
    "max_value" INTEGER,
    "unit" TEXT,
    "policy_class" "PolicyClass" NOT NULL DEFAULT 'GENERAL',
    "version" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attribute_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_capabilities" (
    "id" UUID NOT NULL,
    "partner_org_id" UUID NOT NULL,
    "capability_version" INTEGER NOT NULL,
    "attributes_json" JSONB NOT NULL,
    "geographies_json" JSONB NOT NULL,
    "channels_json" JSONB NOT NULL,
    "status" "CapabilityStatus" NOT NULL DEFAULT 'ACTIVE',
    "mapping_version" INTEGER,
    "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_capabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audience_groups" (
    "id" UUID NOT NULL,
    "buyer_org_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "status" "AudienceGroupStatus" NOT NULL DEFAULT 'DRAFT',
    "current_version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "audience_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audience_group_versions" (
    "audience_group_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "rules_json" JSONB NOT NULL,
    "rule_hash" CHAR(64) NOT NULL,
    "taxonomy_version" INTEGER NOT NULL DEFAULT 1,
    "status" "AudienceVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audience_group_versions_pkey" PRIMARY KEY ("audience_group_id","version")
);

-- CreateTable
CREATE TABLE "partner_match_snapshots" (
    "id" UUID NOT NULL,
    "audience_group_id" UUID NOT NULL,
    "audience_version" INTEGER NOT NULL,
    "partner_org_id" UUID NOT NULL,
    "capability_version" INTEGER NOT NULL,
    "status" "MatchStatus" NOT NULL,
    "match_score" INTEGER NOT NULL,
    "supported_rules_json" JSONB NOT NULL,
    "missing_required_json" JSONB NOT NULL,
    "missing_optional_json" JSONB NOT NULL,
    "channels_json" JSONB NOT NULL,
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_match_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reach_estimates" (
    "id" UUID NOT NULL,
    "audience_group_id" UUID NOT NULL,
    "audience_version" INTEGER NOT NULL,
    "partner_org_id" UUID NOT NULL,
    "status" "ReachEstimateStatus" NOT NULL DEFAULT 'REQUESTED',
    "reach_bucket" "ReachBucket",
    "rule_hash" CHAR(64) NOT NULL,
    "capability_version" INTEGER,
    "mapping_version" INTEGER,
    "freshness_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "failure_reason" TEXT,
    "requested_by" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "reach_estimates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_audience_links" (
    "campaign_id" UUID NOT NULL,
    "audience_group_id" UUID NOT NULL,
    "audience_version" INTEGER NOT NULL,
    "rule_hash" CHAR(64) NOT NULL,
    "linked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_audience_links_pkey" PRIMARY KEY ("campaign_id","audience_group_id")
);

-- CreateIndex
CREATE INDEX "attribute_definitions_category_active_idx" ON "attribute_definitions"("category", "active");

-- CreateIndex
CREATE UNIQUE INDEX "attribute_definitions_key_version_key" ON "attribute_definitions"("key", "version");

-- CreateIndex
CREATE INDEX "partner_capabilities_partner_org_id_status_idx" ON "partner_capabilities"("partner_org_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "partner_capabilities_partner_org_id_capability_version_key" ON "partner_capabilities"("partner_org_id", "capability_version");

-- CreateIndex
CREATE INDEX "audience_groups_buyer_org_id_status_idx" ON "audience_groups"("buyer_org_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "audience_groups_buyer_org_id_name_key" ON "audience_groups"("buyer_org_id", "name");

-- CreateIndex
CREATE INDEX "audience_group_versions_rule_hash_idx" ON "audience_group_versions"("rule_hash");

-- CreateIndex
CREATE INDEX "partner_match_snapshots_partner_org_id_status_idx" ON "partner_match_snapshots"("partner_org_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "partner_match_snapshots_audience_group_id_audience_version__key" ON "partner_match_snapshots"("audience_group_id", "audience_version", "partner_org_id", "capability_version");

-- CreateIndex
CREATE INDEX "reach_estimates_partner_org_id_status_idx" ON "reach_estimates"("partner_org_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "reach_estimates_audience_group_id_audience_version_partner__key" ON "reach_estimates"("audience_group_id", "audience_version", "partner_org_id");

-- CreateIndex
CREATE INDEX "campaign_audience_links_audience_group_id_audience_version_idx" ON "campaign_audience_links"("audience_group_id", "audience_version");

-- AddForeignKey
ALTER TABLE "partner_requests" ADD CONSTRAINT "partner_requests_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "segments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_requests" ADD CONSTRAINT "partner_requests_audience_group_id_fkey" FOREIGN KEY ("audience_group_id") REFERENCES "audience_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_requests" ADD CONSTRAINT "partner_requests_audience_group_id_audience_version_fkey" FOREIGN KEY ("audience_group_id", "audience_version") REFERENCES "audience_group_versions"("audience_group_id", "version") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_requests" ADD CONSTRAINT "partner_requests_reach_estimate_id_fkey" FOREIGN KEY ("reach_estimate_id") REFERENCES "reach_estimates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_capabilities" ADD CONSTRAINT "partner_capabilities_partner_org_id_fkey" FOREIGN KEY ("partner_org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audience_groups" ADD CONSTRAINT "audience_groups_buyer_org_id_fkey" FOREIGN KEY ("buyer_org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audience_groups" ADD CONSTRAINT "audience_groups_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audience_group_versions" ADD CONSTRAINT "audience_group_versions_audience_group_id_fkey" FOREIGN KEY ("audience_group_id") REFERENCES "audience_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_match_snapshots" ADD CONSTRAINT "partner_match_snapshots_audience_group_id_fkey" FOREIGN KEY ("audience_group_id") REFERENCES "audience_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_match_snapshots" ADD CONSTRAINT "partner_match_snapshots_audience_group_id_audience_version_fkey" FOREIGN KEY ("audience_group_id", "audience_version") REFERENCES "audience_group_versions"("audience_group_id", "version") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_match_snapshots" ADD CONSTRAINT "partner_match_snapshots_partner_org_id_fkey" FOREIGN KEY ("partner_org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reach_estimates" ADD CONSTRAINT "reach_estimates_audience_group_id_fkey" FOREIGN KEY ("audience_group_id") REFERENCES "audience_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reach_estimates" ADD CONSTRAINT "reach_estimates_audience_group_id_audience_version_fkey" FOREIGN KEY ("audience_group_id", "audience_version") REFERENCES "audience_group_versions"("audience_group_id", "version") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reach_estimates" ADD CONSTRAINT "reach_estimates_partner_org_id_fkey" FOREIGN KEY ("partner_org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_audience_links" ADD CONSTRAINT "campaign_audience_links_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_audience_links" ADD CONSTRAINT "campaign_audience_links_audience_group_id_fkey" FOREIGN KEY ("audience_group_id") REFERENCES "audience_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_audience_links" ADD CONSTRAINT "campaign_audience_links_audience_group_id_audience_version_fkey" FOREIGN KEY ("audience_group_id", "audience_version") REFERENCES "audience_group_versions"("audience_group_id", "version") ON DELETE RESTRICT ON UPDATE CASCADE;
