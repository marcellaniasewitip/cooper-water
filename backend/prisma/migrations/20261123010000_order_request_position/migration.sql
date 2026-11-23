-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "request_accuracy_m" INTEGER,
ADD COLUMN     "request_lat" DOUBLE PRECISION,
ADD COLUMN     "request_lng" DOUBLE PRECISION;

