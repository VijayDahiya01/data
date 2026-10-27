-- §66.2 marketplace listing: a Partner that only publishes capabilities
-- (Partner Connect) can let every verified Buyer find it. Off by default.
-- AlterTable
ALTER TABLE "partner_profiles" ADD COLUMN     "marketplace_listed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "marketplace_listed_at" TIMESTAMPTZ(6);
