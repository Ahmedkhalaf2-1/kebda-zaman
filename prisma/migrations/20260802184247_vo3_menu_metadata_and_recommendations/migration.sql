-- CreateEnum
CREATE TYPE "MenuItemBadge" AS ENUM ('BESTSELLER', 'TOP_RATED');

-- AlterTable
ALTER TABLE "MenuItem" ADD COLUMN     "badge" "MenuItemBadge",
ADD COLUMN     "calories" INTEGER,
ADD COLUMN     "compareAtPrice" DECIMAL(10,2);

-- CreateTable
CREATE TABLE "MenuItemRecommendation" (
    "id" UUID NOT NULL,
    "menuItemId" UUID NOT NULL,
    "recommendedMenuItemId" UUID NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MenuItemRecommendation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MenuItemRecommendation_menuItemId_displayOrder_idx" ON "MenuItemRecommendation"("menuItemId", "displayOrder");

-- CreateIndex
CREATE INDEX "MenuItemRecommendation_recommendedMenuItemId_idx" ON "MenuItemRecommendation"("recommendedMenuItemId");

-- CreateIndex
CREATE UNIQUE INDEX "MenuItemRecommendation_menuItemId_recommendedMenuItemId_key" ON "MenuItemRecommendation"("menuItemId", "recommendedMenuItemId");

-- AddForeignKey
ALTER TABLE "MenuItemRecommendation" ADD CONSTRAINT "MenuItemRecommendation_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItemRecommendation" ADD CONSTRAINT "MenuItemRecommendation_recommendedMenuItemId_fkey" FOREIGN KEY ("recommendedMenuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
