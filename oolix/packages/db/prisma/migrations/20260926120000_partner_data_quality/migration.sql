-- CreateTable
CREATE TABLE "partner_data_quality" (
    "partner_org_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "sync_mode" TEXT NOT NULL,
    "synced_at" TIMESTAMPTZ(6) NOT NULL,
    "customers_bucket" TEXT NOT NULL,
    "attributes_json" JSONB NOT NULL,
    "reported_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_data_quality_pkey" PRIMARY KEY ("partner_org_id")
);

-- AddForeignKey
ALTER TABLE "partner_data_quality" ADD CONSTRAINT "partner_data_quality_partner_org_id_fkey" FOREIGN KEY ("partner_org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

