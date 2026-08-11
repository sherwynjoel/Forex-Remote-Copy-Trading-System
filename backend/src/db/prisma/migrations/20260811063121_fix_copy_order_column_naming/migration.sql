/*
  Warnings:

  - You are about to drop the column `executionPrice` on the `copy_orders` table. All the data in the column will be lost.
  - You are about to drop the column `requestedVolume` on the `copy_orders` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "copy_orders" DROP COLUMN "executionPrice",
DROP COLUMN "requestedVolume",
ADD COLUMN     "execution_price" DECIMAL(18,5),
ADD COLUMN     "requested_volume" DECIMAL(18,2);
