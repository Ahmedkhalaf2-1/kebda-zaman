import 'reflect-metadata';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { DriversController } from './drivers.controller';

/**
 * Admin driver management must never be reachable by anyone but ADMIN — not
 * CASHIER, KITCHEN, or DRIVER itself (a driver managing driver accounts would
 * be a privilege-escalation path). No method-level overrides exist on this
 * controller, unlike KitchenOrdersController — every route is ADMIN-only.
 */
describe('DriversController — role wiring', () => {
  it('is restricted to ADMIN at the class level', () => {
    expect(Reflect.getMetadata(ROLES_KEY, DriversController)).toEqual(['ADMIN']);
  });

  it.each(['list', 'getById', 'create', 'update'] as const)(
    '%s has no method-level override — falls back to class-level ADMIN-only',
    (method) => {
      expect(Reflect.getMetadata(ROLES_KEY, DriversController.prototype[method])).toBeUndefined();
    },
  );
});
