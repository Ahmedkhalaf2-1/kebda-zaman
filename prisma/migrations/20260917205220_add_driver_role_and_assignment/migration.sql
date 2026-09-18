-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'DRIVER';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "driverId" UUID;

-- CreateTable
CREATE TABLE "OrderDriverAssignmentHistory" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "fromDriverId" UUID,
    "toDriverId" UUID,
    "changedByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderDriverAssignmentHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderDriverAssignmentHistory_orderId_idx" ON "OrderDriverAssignmentHistory"("orderId");

-- CreateIndex
CREATE INDEX "OrderDriverAssignmentHistory_toDriverId_idx" ON "OrderDriverAssignmentHistory"("toDriverId");

-- CreateIndex
CREATE INDEX "Order_driverId_idx" ON "Order"("driverId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderDriverAssignmentHistory" ADD CONSTRAINT "OrderDriverAssignmentHistory_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderDriverAssignmentHistory" ADD CONSTRAINT "OrderDriverAssignmentHistory_fromDriverId_fkey" FOREIGN KEY ("fromDriverId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderDriverAssignmentHistory" ADD CONSTRAINT "OrderDriverAssignmentHistory_toDriverId_fkey" FOREIGN KEY ("toDriverId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderDriverAssignmentHistory" ADD CONSTRAINT "OrderDriverAssignmentHistory_changedByUserId_fkey" FOREIGN KEY ("changedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
