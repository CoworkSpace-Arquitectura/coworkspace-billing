-- AlterEnum
ALTER TYPE "ChargeStatus" ADD VALUE 'REFUNDED';

-- AlterTable
ALTER TABLE "extra_charges" ADD COLUMN     "paid_at" TIMESTAMP(3),
ADD COLUMN     "refunded_at" TIMESTAMP(3),
ADD COLUMN     "stripe_refund_id" TEXT;

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "refunded_at" TIMESTAMP(3);
