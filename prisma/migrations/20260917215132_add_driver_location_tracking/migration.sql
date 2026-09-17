-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "driverAssignmentVersion" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "OrderDriverLocation" (
    "orderId" UUID NOT NULL,
    "driverId" UUID NOT NULL,
    "assignmentVersion" INTEGER NOT NULL,
    "latitude" DECIMAL(9,6) NOT NULL,
    "longitude" DECIMAL(9,6) NOT NULL,
    "accuracyMeters" DECIMAL(7,2),
    "headingDegrees" DECIMAL(5,2),
    "speedMps" DECIMAL(6,2),
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderDriverLocation_pkey" PRIMARY KEY ("orderId")
);

-- CreateIndex
CREATE INDEX "OrderDriverLocation_driverId_idx" ON "OrderDriverLocation"("driverId");

-- AddForeignKey
ALTER TABLE "OrderDriverLocation" ADD CONSTRAINT "OrderDriverLocation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderDriverLocation" ADD CONSTRAINT "OrderDriverLocation_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
