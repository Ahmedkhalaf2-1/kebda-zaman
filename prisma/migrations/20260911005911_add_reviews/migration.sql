-- CreateTable
CREATE TABLE "ItemReview" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "orderItemId" UUID NOT NULL,
    "menuItemId" UUID,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ItemReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderFeedback" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ItemReview_orderItemId_key" ON "ItemReview"("orderItemId");

-- CreateIndex
CREATE INDEX "ItemReview_userId_idx" ON "ItemReview"("userId");

-- CreateIndex
CREATE INDEX "ItemReview_orderId_idx" ON "ItemReview"("orderId");

-- CreateIndex
CREATE INDEX "ItemReview_menuItemId_idx" ON "ItemReview"("menuItemId");

-- CreateIndex
CREATE INDEX "ItemReview_rating_idx" ON "ItemReview"("rating");

-- CreateIndex
CREATE INDEX "ItemReview_createdAt_idx" ON "ItemReview"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrderFeedback_orderId_key" ON "OrderFeedback"("orderId");

-- CreateIndex
CREATE INDEX "OrderFeedback_userId_idx" ON "OrderFeedback"("userId");

-- CreateIndex
CREATE INDEX "OrderFeedback_rating_idx" ON "OrderFeedback"("rating");

-- CreateIndex
CREATE INDEX "OrderFeedback_createdAt_idx" ON "OrderFeedback"("createdAt");

-- AddForeignKey
ALTER TABLE "ItemReview" ADD CONSTRAINT "ItemReview_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemReview" ADD CONSTRAINT "ItemReview_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemReview" ADD CONSTRAINT "ItemReview_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderFeedback" ADD CONSTRAINT "OrderFeedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderFeedback" ADD CONSTRAINT "OrderFeedback_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
