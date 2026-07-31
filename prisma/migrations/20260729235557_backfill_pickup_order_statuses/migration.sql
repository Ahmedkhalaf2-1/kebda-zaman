-- Historical data backfill for the pickup-specific lifecycle introduced by
-- the previous migration (add_pickup_order_statuses). Runs as its own
-- migration/transaction so the two new "OrderStatus" enum values
-- (READY_FOR_PICKUP, PICKED_UP) are already committed and safe to reference
-- by the time these statements execute.
--
-- Only PICKUP orders are semantically wrong under the old shared state
-- machine — a DELIVERY order's OUT_FOR_DELIVERY/DELIVERED status was always
-- correct and must be left untouched. Every statement below is therefore
-- scoped to "deliveryMethod" = 'PICKUP', either directly on "Order" or via a
-- join back to "Order" for "OrderStatusHistory".

-- Order.status: PICKUP orders currently sitting in the old shared statuses
-- move to their pickup-specific equivalents.
UPDATE "Order"
SET "status" = 'READY_FOR_PICKUP'
WHERE "deliveryMethod" = 'PICKUP' AND "status" = 'OUT_FOR_DELIVERY';

UPDATE "Order"
SET "status" = 'PICKED_UP'
WHERE "deliveryMethod" = 'PICKUP' AND "status" = 'DELIVERED';

-- OrderStatusHistory: rewrite both the "toStatus" of the row that recorded
-- the transition into the old shared status, and the "fromStatus" of
-- whatever row recorded the transition out of it, so the full audit trail
-- for PICKUP orders reads consistently with the corrected lifecycle.
UPDATE "OrderStatusHistory" h
SET "toStatus" = 'READY_FOR_PICKUP'
FROM "Order" o
WHERE h."orderId" = o."id"
  AND o."deliveryMethod" = 'PICKUP'
  AND h."toStatus" = 'OUT_FOR_DELIVERY';

UPDATE "OrderStatusHistory" h
SET "fromStatus" = 'READY_FOR_PICKUP'
FROM "Order" o
WHERE h."orderId" = o."id"
  AND o."deliveryMethod" = 'PICKUP'
  AND h."fromStatus" = 'OUT_FOR_DELIVERY';

UPDATE "OrderStatusHistory" h
SET "toStatus" = 'PICKED_UP'
FROM "Order" o
WHERE h."orderId" = o."id"
  AND o."deliveryMethod" = 'PICKUP'
  AND h."toStatus" = 'DELIVERED';

UPDATE "OrderStatusHistory" h
SET "fromStatus" = 'PICKED_UP'
FROM "Order" o
WHERE h."orderId" = o."id"
  AND o."deliveryMethod" = 'PICKUP'
  AND h."fromStatus" = 'DELIVERED';
