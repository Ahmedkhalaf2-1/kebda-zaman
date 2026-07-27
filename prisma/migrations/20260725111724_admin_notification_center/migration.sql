-- CreateTable
CREATE TABLE "AdminNotification" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'NEW_ORDER',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "orderId" UUID,
    "customerId" UUID,
    "customerName" TEXT,
    "orderNumber" TEXT,
    "totalAmount" DECIMAL(10,2),
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminNotification_isRead_idx" ON "AdminNotification"("isRead");

-- CreateIndex
CREATE INDEX "AdminNotification_createdAt_idx" ON "AdminNotification"("createdAt");
