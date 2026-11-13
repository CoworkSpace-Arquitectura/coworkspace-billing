/*
  Warnings:

  - A unique constraint covering the columns `[subscription_id]` on the table `extra_charges` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "extra_charges" ADD COLUMN     "subscription_id" TEXT,
ALTER COLUMN "booking_id" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "extra_charges_subscription_id_key" ON "extra_charges"("subscription_id");
