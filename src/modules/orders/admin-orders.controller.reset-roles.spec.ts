import 'reflect-metadata';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { AdminOrdersController } from './admin-orders.controller';

/**
 * The order-wipe endpoint is destructive (permanently deletes every order),
 * so it overrides the class-level ADMIN+CASHIER down to ADMIN-only — same
 * pattern as assignDriver/unassignDriver (see the driver-assignment roles
 * spec). The read-only preview endpoint stays at the class-level roles.
 */
describe('AdminOrdersController — reset-endpoint role wiring', () => {
  it('resetOrders overrides to ADMIN-only (not CASHIER)', () => {
    const roles = Reflect.getMetadata(ROLES_KEY, AdminOrdersController.prototype.resetOrders);
    expect(roles).toEqual(['ADMIN']);
    expect(roles).not.toContain('CASHIER');
  });

  it('ordersResetPreview has no method-level override (inherits ADMIN+CASHIER)', () => {
    const roles = Reflect.getMetadata(
      ROLES_KEY,
      AdminOrdersController.prototype.ordersResetPreview,
    );
    expect(roles).toBeUndefined();
  });
});
