import 'reflect-metadata';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { OrdersController } from './orders.controller';
import { AdminOrdersController } from './admin-orders.controller';

/**
 * Phase 2 tracking-read role wiring:
 *  - OrdersController.getOrderTracking: no method-level @Roles(), same as
 *    its siblings getOrder/getOrderStatus — open to any authenticated owner
 *    (customer or guest), scoped by userId ownership inside the service, not
 *    by role.
 *  - AdminOrdersController.getOrderTracking: no override — inherits the
 *    class-level ADMIN+CASHIER (the same "authorized staff" bar as every
 *    other read on that controller), never DRIVER/CUSTOMER.
 */
describe('Tracking-read controllers — role wiring', () => {
  it('OrdersController.getOrderTracking has no @Roles() override (ownership-scoped, not role-scoped)', () => {
    expect(
      Reflect.getMetadata(ROLES_KEY, OrdersController.prototype.getOrderTracking),
    ).toBeUndefined();
  });

  it('AdminOrdersController stays ADMIN + CASHIER at the class level', () => {
    expect(Reflect.getMetadata(ROLES_KEY, AdminOrdersController)).toEqual(['ADMIN', 'CASHIER']);
  });

  it('AdminOrdersController.getOrderTracking has no method-level override', () => {
    expect(
      Reflect.getMetadata(ROLES_KEY, AdminOrdersController.prototype.getOrderTracking),
    ).toBeUndefined();
  });
});
