import 'reflect-metadata';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { ReviewsController } from './reviews.controller';
import { AdminReviewsController } from './admin-reviews.controller';

/**
 * The global RolesGuard reads this metadata (roles.guard.ts) to allow/reject
 * a principal — verified generically there. Here we only verify each review
 * controller declares the correct role contract: customer endpoints are
 * CUSTOMER-only (guests are further excluded in-handler via assertNotGuest,
 * since role=CUSTOMER alone doesn't exclude guests), and admin endpoints are
 * ADMIN-only — CASHIER/KITCHEN get 403, same as promos/menu-offers/customers/
 * reports (review moderation is not order-ops, unlike /admin/orders).
 */
describe('Reviews controllers — role wiring', () => {
  it('ReviewsController is restricted to CUSTOMER', () => {
    expect(Reflect.getMetadata(ROLES_KEY, ReviewsController)).toEqual(['CUSTOMER']);
  });

  it('AdminReviewsController is restricted to ADMIN only (not CASHIER/KITCHEN)', () => {
    expect(Reflect.getMetadata(ROLES_KEY, AdminReviewsController)).toEqual(['ADMIN']);
  });
});
