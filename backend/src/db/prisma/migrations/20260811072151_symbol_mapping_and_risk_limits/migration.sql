-- AlterTable
ALTER TABLE "slaves" ADD COLUMN     "allowed_symbols" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "blocked_symbols" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "emergency_stop" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "max_exposure" DECIMAL(18,2),
ADD COLUMN     "max_positions" INTEGER;

-- CreateTable
CREATE TABLE "symbol_mappings" (
    "id" TEXT NOT NULL,
    "slave_id" TEXT NOT NULL,
    "master_symbol" TEXT NOT NULL,
    "slave_symbol" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "symbol_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "symbol_mappings_slave_id_master_symbol_key" ON "symbol_mappings"("slave_id", "master_symbol");

-- AddForeignKey
ALTER TABLE "symbol_mappings" ADD CONSTRAINT "symbol_mappings_slave_id_fkey" FOREIGN KEY ("slave_id") REFERENCES "slaves"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
