-- docs/DESIGN-PARTNER-DATA.md §5.6: Partners' answers for values their Agents
-- could not read, shared by choice (values and codes only), and Oolix's review
-- of them.
-- CreateTable
CREATE TABLE "synonym_contributions" (
    "id" UUID NOT NULL,
    "partner_org_id" UUID NOT NULL,
    "attribute_key" TEXT NOT NULL,
    "value_key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "synonym_contributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shared_synonyms" (
    "id" UUID NOT NULL,
    "attribute_key" TEXT NOT NULL,
    "value_key" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "decided_by" UUID NOT NULL,
    "decided_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shared_synonyms_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "synonym_contributions_value_idx" ON "synonym_contributions"("attribute_key", "value_key");

-- CreateIndex
CREATE UNIQUE INDEX "synonym_contributions_org_value_key" ON "synonym_contributions"("partner_org_id", "attribute_key", "value_key");

-- CreateIndex
CREATE INDEX "shared_synonyms_status_idx" ON "shared_synonyms"("status", "decided_at");

-- CreateIndex
CREATE UNIQUE INDEX "shared_synonyms_value_key" ON "shared_synonyms"("attribute_key", "value_key");

-- AddForeignKey
ALTER TABLE "synonym_contributions" ADD CONSTRAINT "synonym_contributions_partner_org_id_fkey" FOREIGN KEY ("partner_org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
