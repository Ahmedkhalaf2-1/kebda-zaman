import 'reflect-metadata';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { KitchenOrdersController } from './kitchen-orders.controller';

/**
 * The global RolesGuard reads this metadata (roles.guard.ts, unit-tested
 * generically there) to allow/reject a principal — here we only verify
 * KitchenOrdersController declares the correct role contract per route
 * (Manual Kitchen Preparation Time / ETA feature):
 *  - listOrders/getOrder stay KITCHEN-only (class-level @Roles('KITCHEN'),
 *    no method-level override) — never accidentally widened.
 *  - setPreparationTime overrides with a method-level @Roles('KITCHEN',
 *    'ADMIN') (RolesGuard's getAllAndOverride prefers handler metadata over
 *    class metadata), so KITCHEN and ADMIN can call it but CASHIER/CUSTOMER
 *    cannot (neither role is ever in either list).
 */
describe('KitchenOrdersController — role wiring', () => {
  it('is restricted to KITCHEN at the class level', () => {
    expect(Reflect.getMetadata(ROLES_KEY, KitchenOrdersController)).toEqual(['KITCHEN']);
  });

  it('listOrders has no method-level override — falls back to class-level KITCHEN-only', () => {
    expect(
      Reflect.getMetadata(ROLES_KEY, KitchenOrdersController.prototype.listOrders),
    ).toBeUndefined();
  });

  it('getOrder has no method-level override — falls back to class-level KITCHEN-only', () => {
    expect(
      Reflect.getMetadata(ROLES_KEY, KitchenOrdersController.prototype.getOrder),
    ).toBeUndefined();
  });

  it('setPreparationTime overrides to KITCHEN + ADMIN (not CASHIER/CUSTOMER)', () => {
    const roles = Reflect.getMetadata(
      ROLES_KEY,
      KitchenOrdersController.prototype.setPreparationTime,
    );
    expect(roles).toEqual(['KITCHEN', 'ADMIN']);
    expect(roles).not.toContain('CASHIER');
    expect(roles).not.toContain('CUSTOMER');
  });
});
