-- CreateTable
CREATE TABLE "MenuOffer" (
    "id" UUID NOT NULL,
    "menuItemId" UUID NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MenuOffer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MenuOffer_menuItemId_idx" ON "MenuOffer"("menuItemId");

-- CreateIndex
CREATE INDEX "MenuOffer_isActive_sortOrder_idx" ON "MenuOffer"("isActive", "sortOrder");

-- AddForeignKey
ALTER TABLE "MenuOffer" ADD CONSTRAINT "MenuOffer_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
