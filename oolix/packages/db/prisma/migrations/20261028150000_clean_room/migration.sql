-- docs/DESIGN-PARTNER-DATA.md phase 7: a Partner's opt-in to cross-Partner
-- matching, and clean-room runs -- who, what and a size band, never a match key.
-- AlterTable
ALTER TABLE "partner_profiles" ADD COLUMN     "cross_partner_matching" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "cross_partner_matching_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "clean_room_runs" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "requested_by" UUID NOT NULL,
    "with_org" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "result_json" JSONB,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "clean_room_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "clean_room_runs_requested_idx" ON "clean_room_runs"("requested_by", "created_at");

-- CreateIndex
CREATE INDEX "clean_room_runs_with_idx" ON "clean_room_runs"("with_org", "created_at");

