-- AlterEnum
ALTER TYPE "NotificationChannel" ADD VALUE 'whatsapp';

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "delivery_status" TEXT,
ADD COLUMN     "fallback_at" TIMESTAMP(3),
ADD COLUMN     "provider_message_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "notifications_provider_message_id_key" ON "notifications"("provider_message_id");

