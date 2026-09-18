-- Distance-based delivery pricing: replaces DeliveryZone-driven checkout
-- pricing with a Google-Routes-computed distance matched against
-- admin-configured DeliveryDistanceTier rows.
--
-- Hand-edited (not the raw `prisma migrate dev` output) so the existing
-- singleton RestaurantSettings row's new required columns can be safely
-- backfilled instead of failing on a NOT NULL constraint against existing
-- data. Mirrors the precedent set by
-- 20260728135522_restaurant_settings_and_delivery_zones/migration.sql.
--
-- DeliveryZone (table + its Order FK/snapshot columns) is intentionally left
-- untouched by this migration — see the deprecation note in schema.prisma.
-- No column is dropped and no historical Order row is modified.

-- ---------------------------------------------------------------------------
-- RestaurantSettings: restaurant origin coordinates for Google Routes calls.
-- Added nullable first so the existing singleton row is never rejected by a
-- NOT NULL constraint, backfilled with the approved production coordinates,
-- then locked to NOT NULL (safe: this table has exactly one row, and it is
-- backfilled by the UPDATE immediately above).
-- ---------------------------------------------------------------------------
ALTER TABLE "RestaurantSettings" ADD COLUMN "restaurantLatitude" DECIMAL(10,7);
ALTER TABLE "RestaurantSettings" ADD COLUMN "restaurantLongitude" DECIMAL(10,7);

-- Only backfills rows that are still NULL — never overwrites an
-- already-configured value, so this is safe to leave in a re-applied/replayed
-- migration history.
UPDATE "RestaurantSettings"
SET "restaurantLatitude" = 21.5705641,
    "restaurantLongitude" = 39.1681808
WHERE "restaurantLatitude" IS NULL;

ALTER TABLE "RestaurantSettings" ALTER COLUMN "restaurantLatitude" SET NOT NULL;
ALTER TABLE "RestaurantSettings" ALTER COLUMN "restaurantLongitude" SET NOT NULL;

-- ---------------------------------------------------------------------------
-- DeliveryDistanceTier: ADMIN-managed distance-based fee tiers. Authoritative
-- source for DELIVERY pricing going forward (see DeliveryPricingService).
-- ---------------------------------------------------------------------------
CREATE TABLE "DeliveryDistanceTier" (
    "id" UUID NOT NULL,
    "minDistanceKm" DECIMAL(5,2) NOT NULL,
    "maxDistanceKm" DECIMAL(5,2) NOT NULL,
    "deliveryFee" DECIMAL(10,2) NOT NULL,
    "minimumOrder" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryDistanceTier_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DeliveryDistanceTier_isActive_sortOrder_idx" ON "DeliveryDistanceTier"("isActive", "sortOrder");

-- Idempotent initial seed of the 3 approved tiers. Only runs when the table
-- is completely empty, so re-running this migration (or a future replay)
-- never duplicates rows or clobbers tiers an admin has since edited.
-- minimumOrder is left at its default (0) for all three — the approved
-- business input defines delivery fees only; RestaurantSettings.minOrderAmount
-- remains the authoritative store-wide floor unless/until an admin sets a
-- tier-specific minimum above 0 (see DeliveryPricingService/OrdersService).
INSERT INTO "DeliveryDistanceTier"
  ("id", "minDistanceKm", "maxDistanceKm", "deliveryFee", "minimumOrder", "isActive", "sortOrder", "updatedAt")
SELECT * FROM (
  VALUES
    (gen_random_uuid(), 0.00::decimal(5,2), 15.00::decimal(5,2), 10.00::decimal(10,2), 0.00::decimal(10,2), true, 0, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 15.00::decimal(5,2), 25.00::decimal(5,2), 15.00::decimal(10,2), 0.00::decimal(10,2), true, 1, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 25.00::decimal(5,2), 30.00::decimal(5,2), 25.00::decimal(10,2), 0.00::decimal(10,2), true, 2, CURRENT_TIMESTAMP)
) AS seed
WHERE NOT EXISTS (SELECT 1 FROM "DeliveryDistanceTier");

-- ---------------------------------------------------------------------------
-- Order: distance-pricing snapshot columns (all nullable — null for every
-- pre-existing order, and for PICKUP orders going forward; DeliveryZone's own
-- snapshot columns on this table are left as-is, deprecated but readable).
-- ---------------------------------------------------------------------------
ALTER TABLE "Order" ADD COLUMN "deliveryDistanceMeters" INTEGER;
ALTER TABLE "Order" ADD COLUMN "deliveryDurationSeconds" INTEGER;
ALTER TABLE "Order" ADD COLUMN "deliveryTierId" UUID;
ALTER TABLE "Order" ADD COLUMN "deliveryTierMinKmSnapshot" DECIMAL(5,2);
ALTER TABLE "Order" ADD COLUMN "deliveryTierMaxKmSnapshot" DECIMAL(5,2);
