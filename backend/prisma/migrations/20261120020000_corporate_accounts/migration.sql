-- AlterEnum
ALTER TYPE "LedgerType" ADD VALUE 'company_payment';

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'account';

-- AlterEnum
ALTER TYPE "WalletOwnerType" ADD VALUE 'company';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "company_id" UUID;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "company_id" UUID;

-- CreateTable
CREATE TABLE "companies" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "contact_name" TEXT NOT NULL DEFAULT '',
    "contact_email" TEXT NOT NULL DEFAULT '',
    "contact_phone" TEXT NOT NULL DEFAULT '',
    "credit_limit_toea" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_statements" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "month" TEXT NOT NULL,
    "order_count" INTEGER NOT NULL,
    "litres" INTEGER NOT NULL DEFAULT 0,
    "charged_toea" INTEGER NOT NULL,
    "payments_toea" INTEGER NOT NULL,
    "opening_balance_toea" INTEGER NOT NULL,
    "closing_balance_toea" INTEGER NOT NULL,
    "emailed_to" TEXT,
    "emailed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_statements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "company_statements_company_id_month_key" ON "company_statements"("company_id", "month");

-- CreateIndex
CREATE INDEX "orders_company_id_created_at_idx" ON "orders"("company_id", "created_at");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_statements" ADD CONSTRAINT "company_statements_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

