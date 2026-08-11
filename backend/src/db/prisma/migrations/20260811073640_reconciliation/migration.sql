-- CreateEnum
CREATE TYPE "ReconciliationFindingType" AS ENUM ('MISSING_COPY', 'SLAVE_POSITION_MISSING', 'VOLUME_MISMATCH', 'SLTP_MISMATCH', 'SLAVE_NOT_CLOSED', 'UNEXPECTED_SLAVE_POSITION', 'DUPLICATE_SLAVE_POSITION');

-- AlterTable
ALTER TABLE "masters" ADD COLUMN     "position_snapshot" JSONB,
ADD COLUMN     "position_snapshot_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "slaves" ADD COLUMN     "position_snapshot" JSONB,
ADD COLUMN     "position_snapshot_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "reconciliation_findings" (
    "id" TEXT NOT NULL,
    "master_id" TEXT NOT NULL,
    "slave_id" TEXT NOT NULL,
    "type" "ReconciliationFindingType" NOT NULL,
    "master_ticket" TEXT,
    "slave_ticket" TEXT,
    "details" JSONB NOT NULL,
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliation_findings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reconciliation_findings_master_id_idx" ON "reconciliation_findings"("master_id");

-- CreateIndex
CREATE INDEX "reconciliation_findings_slave_id_idx" ON "reconciliation_findings"("slave_id");

-- AddForeignKey
ALTER TABLE "reconciliation_findings" ADD CONSTRAINT "reconciliation_findings_master_id_fkey" FOREIGN KEY ("master_id") REFERENCES "masters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_findings" ADD CONSTRAINT "reconciliation_findings_slave_id_fkey" FOREIGN KEY ("slave_id") REFERENCES "slaves"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
