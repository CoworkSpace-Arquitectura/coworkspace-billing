-- CreateEnum
CREATE TYPE "ChargeStatus" AS ENUM ('PENDING', 'PAID', 'FAILED');

-- CreateTable
CREATE TABLE "extra_charges" (
    "id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "ChargeStatus" NOT NULL DEFAULT 'PENDING',
    "stripe_session_id" TEXT,
    "checkout_url" TEXT,
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "extra_charges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "plan_name" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'COP',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "extra_charges_booking_id_key" ON "extra_charges"("booking_id");

-- CreateIndex
CREATE UNIQUE INDEX "extra_charges_stripe_session_id_key" ON "extra_charges"("stripe_session_id");

-- CreateIndex
CREATE INDEX "extra_charges_status_idx" ON "extra_charges"("status");

-- CreateIndex
CREATE INDEX "extra_charges_member_id_idx" ON "extra_charges"("member_id");

-- CreateIndex
CREATE INDEX "invoices_member_id_idx" ON "invoices"("member_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_subscription_id_period_key" ON "invoices"("subscription_id", "period");
