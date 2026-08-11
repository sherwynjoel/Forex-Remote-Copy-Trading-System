-- AlterTable
ALTER TABLE "trade_events" ADD COLUMN     "detection_latency_ms" INTEGER,
ADD COLUMN     "network_latency_ms" INTEGER,
ADD COLUMN     "total_latency_ms" INTEGER;

-- CreateTable
CREATE TABLE "admins" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admins_username_key" ON "admins"("username");
