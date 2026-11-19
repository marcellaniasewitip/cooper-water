-- Customer email (optional) for emailed receipts.
ALTER TABLE "users" ADD COLUMN "email" TEXT;

-- Receipt sending on orders.
ALTER TABLE "orders" ADD COLUMN "receipt_email" TEXT;
ALTER TABLE "orders" ADD COLUMN "receipt_sent_at" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "receipt_send_count" INTEGER NOT NULL DEFAULT 0;

-- Customer signature at delivery.
CREATE TABLE "order_signatures" (
    "order_id" UUID NOT NULL,
    "png" BYTEA NOT NULL,
    "signed_by_name" TEXT NOT NULL DEFAULT '',
    "signed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "driver_id" UUID NOT NULL,

    CONSTRAINT "order_signatures_pkey" PRIMARY KEY ("order_id")
);

ALTER TABLE "order_signatures" ADD CONSTRAINT "order_signatures_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
