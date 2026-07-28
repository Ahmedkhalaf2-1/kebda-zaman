-- Phase 8: restaurant profile Ar/En split, weekly operating hours, manual
-- order-acceptance gate, and ADMIN-managed delivery zones.
--
-- Hand-written (not `prisma migrate dev`-generated) so the existing singleton
-- RestaurantSettings row's data can be safely backfilled instead of dropped.

-- ---------------------------------------------------------------------------
-- RestaurantSettings: split restaurantName/addressText into Ar/En pairs,
-- backfilling both languages from the prior single value (no data loss).
-- ---------------------------------------------------------------------------
ALTER TABLE "RestaurantSettings" ADD COLUMN "restaurantNameAr" TEXT;
ALTER TABLE "RestaurantSettings" ADD COLUMN "restaurantNameEn" TEXT;
ALTER TABLE "RestaurantSettings" ADD COLUMN "addressAr" TEXT;
ALTER TABLE "RestaurantSettings" ADD COLUMN "addressEn" TEXT;

UPDATE "RestaurantSettings"
SET "restaurantNameAr" = "restaurantName",
    "restaurantNameEn" = "restaurantName",
    "addressAr" = "addressText",
    "addressEn" = "addressText";

ALTER TABLE "RestaurantSettings" ALTER COLUMN "restaurantNameAr" SET NOT NULL;
ALTER TABLE "RestaurantSettings" ALTER COLUMN "restaurantNameEn" SET NOT NULL;
ALTER TABLE "RestaurantSettings" ALTER COLUMN "addressAr" SET NOT NULL;
ALTER TABLE "RestaurantSettings" ALTER COLUMN "addressEn" SET NOT NULL;

ALTER TABLE "RestaurantSettings" DROP COLUMN "restaurantName";
ALTER TABLE "RestaurantSettings" DROP COLUMN "addressText";

-- ---------------------------------------------------------------------------
-- RestaurantSettings: new profile / hours / acceptance-state columns.
-- ---------------------------------------------------------------------------
ALTER TABLE "RestaurantSettings" ADD COLUMN "logoUrl" TEXT;
ALTER TABLE "RestaurantSettings" ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'Africa/Cairo';
ALTER TABLE "RestaurantSettings" ADD COLUMN "acceptingOrders" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "RestaurantSettings" ADD COLUMN "closedMessageAr" TEXT;
ALTER TABLE "RestaurantSettings" ADD COLUMN "closedMessageEn" TEXT;

-- workingHours keeps its column name, but its JSON shape changes from a
-- single {open, close} pair to a 7-entry per-day array. Backfill every day
-- from the prior single pair with isOpen = true, preserving the restaurant's
-- previously effective hours (only rows that still have the old shape are
-- touched, so this is a no-op if ever re-run against already-migrated data).
UPDATE "RestaurantSettings"
SET "workingHours" = (
  SELECT jsonb_agg(
    jsonb_build_object(
      'dayOfWeek', d,
      'isOpen', true,
      'openTime', "workingHours"->>'open',
      'closeTime', "workingHours"->>'close'
    )
    ORDER BY d
  )
  FROM generate_series(0, 6) AS d
)
WHERE "workingHours" ? 'open';

-- ---------------------------------------------------------------------------
-- DeliveryZone: ADMIN-managed flat fee + minimum per named area.
-- ---------------------------------------------------------------------------
CREATE TABLE "DeliveryZone" (
    "id" UUID NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "deliveryFee" DECIMAL(10,2) NOT NULL,
    "minimumOrder" DECIMAL(10,2) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "DeliveryZone_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DeliveryZone_isActive_sortOrder_idx" ON "DeliveryZone"("isActive", "sortOrder");

-- ---------------------------------------------------------------------------
-- Order: delivery-zone reference + bilingual name snapshot. `deliveryFee`
-- already existing on Order remains the authoritative fee-amount snapshot.
-- ---------------------------------------------------------------------------
ALTER TABLE "Order" ADD COLUMN "deliveryZoneId" UUID;
ALTER TABLE "Order" ADD COLUMN "deliveryZoneNameArSnapshot" TEXT;
ALTER TABLE "Order" ADD COLUMN "deliveryZoneNameEnSnapshot" TEXT;

CREATE INDEX "Order_deliveryZoneId_idx" ON "Order"("deliveryZoneId");

ALTER TABLE "Order" ADD CONSTRAINT "Order_deliveryZoneId_fkey"
    FOREIGN KEY ("deliveryZoneId") REFERENCES "DeliveryZone"("id") ON DELETE SET NULL ON UPDATE CASCADE;
