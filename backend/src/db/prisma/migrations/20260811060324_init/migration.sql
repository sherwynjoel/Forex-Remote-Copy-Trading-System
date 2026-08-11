-- CreateEnum
CREATE TYPE "MasterStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "ConnectorStatus" AS ENUM ('ONLINE', 'OFFLINE', 'CONNECTING', 'ERROR');

-- CreateEnum
CREATE TYPE "TradeEventType" AS ENUM ('OPEN', 'CLOSE', 'MODIFY', 'PARTIAL_CLOSE', 'PENDING_OPEN', 'PENDING_MODIFY', 'PENDING_CANCEL');

-- CreateEnum
CREATE TYPE "TradeSide" AS ENUM ('BUY', 'SELL');

-- CreateTable
CREATE TABLE "masters" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "account_number" TEXT NOT NULL,
    "broker" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'MT5',
    "server" TEXT NOT NULL,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "masters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connectors" (
    "id" TEXT NOT NULL,
    "master_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "version" TEXT,
    "status" "ConnectorStatus" NOT NULL DEFAULT 'CONNECTING',
    "last_heartbeat_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connectors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trade_events" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "master_id" TEXT NOT NULL,
    "master_ticket" TEXT NOT NULL,
    "type" "TradeEventType" NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" "TradeSide",
    "volume" DECIMAL(18,2),
    "price" DECIMAL(18,5),
    "sl" DECIMAL(18,5),
    "tp" DECIMAL(18,5),
    "raw_payload" JSONB NOT NULL,
    "master_event_time" TIMESTAMP(3) NOT NULL,
    "ea_sent_time" TIMESTAMP(3) NOT NULL,
    "backend_received_time" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trade_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "old_value" JSONB,
    "new_value" JSONB,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "masters_account_number_key" ON "masters"("account_number");

-- CreateIndex
CREATE UNIQUE INDEX "connectors_token_hash_key" ON "connectors"("token_hash");

-- CreateIndex
CREATE INDEX "connectors_master_id_idx" ON "connectors"("master_id");

-- CreateIndex
CREATE UNIQUE INDEX "trade_events_event_id_key" ON "trade_events"("event_id");

-- CreateIndex
CREATE INDEX "trade_events_master_id_idx" ON "trade_events"("master_id");

-- CreateIndex
CREATE INDEX "trade_events_master_ticket_idx" ON "trade_events"("master_ticket");

-- CreateIndex
CREATE INDEX "trade_events_created_at_idx" ON "trade_events"("created_at");

-- CreateIndex
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs"("entity");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- AddForeignKey
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_master_id_fkey" FOREIGN KEY ("master_id") REFERENCES "masters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_events" ADD CONSTRAINT "trade_events_master_id_fkey" FOREIGN KEY ("master_id") REFERENCES "masters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
