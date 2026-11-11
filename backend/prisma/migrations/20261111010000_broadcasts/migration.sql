-- Admin push messages ("broadcasts") to drivers and customers.
CREATE TABLE "broadcasts" (
    "id" UUID NOT NULL,
    "audience" TEXT NOT NULL,
    "user_id" UUID,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "recipients" INTEGER NOT NULL DEFAULT 0,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broadcasts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "broadcasts_audience_check" CHECK ("audience" IN ('drivers', 'customers', 'all', 'user'))
);

CREATE INDEX "broadcasts_created_at_idx" ON "broadcasts"("created_at");

-- Inbox / Announcements read notifications by user and template.
CREATE INDEX "notifications_user_id_template_idx" ON "notifications"("user_id", "template");
