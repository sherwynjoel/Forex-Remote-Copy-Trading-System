-- CreateEnum
CREATE TYPE "SlaveStatus" AS ENUM ('ONLINE', 'OFFLINE', 'CONNECTING', 'ERROR', 'DISABLED');

-- CreateEnum
CREATE TYPE "CopyOrderStatus" AS ENUM ('PENDING', 'SENT', 'EXECUTED', 'FAILED', 'REJECTED');

-- DropForeignKey
ALTER TABLE "connectors" DROP CONSTRAINT "connectors_master_id_fkey";

-- AlterTable
ALTER TABLE "connectors" ADD COLUMN     "slave_id" TEXT,
ALTER COLUMN "master_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "slaves" (
    "id" TEXT NOT NULL,
    "master_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "account_number" TEXT NOT NULL,
    "broker" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'MT5',
    "server" TEXT NOT NULL,
    "status" "SlaveStatus" NOT NULL DEFAULT 'CONNECTING',
    "copy_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "slaves_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "copy_orders" (
    "id" TEXT NOT NULL,
    "trade_event_id" TEXT NOT NULL,
    "master_id" TEXT NOT NULL,
    "slave_id" TEXT NOT NULL,
    "master_ticket" TEXT NOT NULL,
    "type" "TradeEventType" NOT NULL,
    "status" "CopyOrderStatus" NOT NULL DEFAULT 'PENDING',
    "requestedVolume" DECIMAL(18,2),
    "slave_ticket" TEXT,
    "executionPrice" DECIMAL(18,5),
    "error_reason" TEXT,
    "sent_at" TIMESTAMP(3),
    "executed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "copy_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "slaves_account_number_key" ON "slaves"("account_number");

-- CreateIndex
CREATE INDEX "slaves_master_id_idx" ON "slaves"("master_id");

-- CreateIndex
CREATE INDEX "copy_orders_slave_id_master_ticket_status_idx" ON "copy_orders"("slave_id", "master_ticket", "status");

-- CreateIndex
CREATE INDEX "copy_orders_master_id_idx" ON "copy_orders"("master_id");

-- CreateIndex
CREATE UNIQUE INDEX "copy_orders_trade_event_id_slave_id_key" ON "copy_orders"("trade_event_id", "slave_id");

-- CreateIndex
CREATE INDEX "connectors_slave_id_idx" ON "connectors"("slave_id");

-- AddForeignKey
ALTER TABLE "slaves" ADD CONSTRAINT "slaves_master_id_fkey" FOREIGN KEY ("master_id") REFERENCES "masters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_master_id_fkey" FOREIGN KEY ("master_id") REFERENCES "masters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_slave_id_fkey" FOREIGN KEY ("slave_id") REFERENCES "slaves"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "copy_orders" ADD CONSTRAINT "copy_orders_trade_event_id_fkey" FOREIGN KEY ("trade_event_id") REFERENCES "trade_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "copy_orders" ADD CONSTRAINT "copy_orders_master_id_fkey" FOREIGN KEY ("master_id") REFERENCES "masters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "copy_orders" ADD CONSTRAINT "copy_orders_slave_id_fkey" FOREIGN KEY ("slave_id") REFERENCES "slaves"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
