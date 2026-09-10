-- AlterTable
ALTER TABLE "activations" ADD COLUMN     "materialization_status" VARCHAR(24),
ADD COLUMN     "materialization_version" INTEGER,
ADD COLUMN     "materialized_at" TIMESTAMPTZ(6);
