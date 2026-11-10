-- CreateEnum
CREATE TYPE "DiscountType" AS ENUM ('percent', 'flat');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "LedgerType" ADD VALUE 'order_payment';
ALTER TYPE "LedgerType" ADD VALUE 'promo';
ALTER TYPE "LedgerType" ADD VALUE 'referral';

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'wallet';

-- AlterEnum
ALTER TYPE "TopupMethod" ADD VALUE 'cash';

-- AlterEnum
ALTER TYPE "WalletOwnerType" ADD VALUE 'customer';

-- DropForeignKey
ALTER TABLE "topup_requests" DROP CONSTRAINT "topup_requests_driver_id_fkey";

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "discount_toea" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "promo_code_id" UUID;

-- AlterTable
ALTER TABLE "topup_requests" ADD COLUMN     "customer_id" UUID,
ALTER COLUMN "driver_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "referral_code" TEXT,
ADD COLUMN     "referral_rewarded_at" TIMESTAMP(3),
ADD COLUMN     "referred_by_id" UUID;

-- CreateTable
CREATE TABLE "promo_codes" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "discount_type" "DiscountType" NOT NULL,
    "discount_value" INTEGER NOT NULL,
    "max_discount_toea" INTEGER,
    "min_order_toea" INTEGER NOT NULL DEFAULT 0,
    "starts_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "max_uses" INTEGER,
    "per_customer_limit" INTEGER NOT NULL DEFAULT 1,
    "public" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "promo_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promo_redemptions" (
    "id" UUID NOT NULL,
    "promo_code_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "discount_toea" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promo_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "sender_id" UUID NOT NULL,
    "sender_role" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "promo_codes_code_key" ON "promo_codes"("code");

-- CreateIndex
CREATE UNIQUE INDEX "promo_redemptions_order_id_key" ON "promo_redemptions"("order_id");

-- CreateIndex
CREATE INDEX "promo_redemptions_promo_code_id_idx" ON "promo_redemptions"("promo_code_id");

-- CreateIndex
CREATE INDEX "promo_redemptions_customer_id_idx" ON "promo_redemptions"("customer_id");

-- CreateIndex
CREATE INDEX "chat_messages_order_id_created_at_idx" ON "chat_messages"("order_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "users_referral_code_key" ON "users"("referral_code");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_referred_by_id_fkey" FOREIGN KEY ("referred_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_promo_code_id_fkey" FOREIGN KEY ("promo_code_id") REFERENCES "promo_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topup_requests" ADD CONSTRAINT "topup_requests_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topup_requests" ADD CONSTRAINT "topup_requests_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promo_redemptions" ADD CONSTRAINT "promo_redemptions_promo_code_id_fkey" FOREIGN KEY ("promo_code_id") REFERENCES "promo_codes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promo_redemptions" ADD CONSTRAINT "promo_redemptions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promo_redemptions" ADD CONSTRAINT "promo_redemptions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A top-up belongs to exactly one driver or one customer.
ALTER TABLE "topup_requests" ADD CONSTRAINT "topup_requests_one_owner"
  CHECK ((driver_id IS NOT NULL)::int + (customer_id IS NOT NULL)::int = 1);
CREATE INDEX "topup_requests_customer_id_idx" ON "topup_requests"("customer_id");
