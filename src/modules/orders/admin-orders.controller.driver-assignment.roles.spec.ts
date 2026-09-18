import 'reflect-metadata';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { AdminOrdersController } from './admin-orders.controller';

/**
 * Manual driver assignment is an ADMIN-only responsibility per the plan, even
 * though the rest of this controller (list/get/status) is ADMIN+CASHIER —
 * assignDriver/unassignDriver override the class-level roles down to ADMIN
 * only (RolesGuard's getAllAndOverride prefers handler metadata over class
 * metadata), so CASHIER can never assign/reassign/unassign a driver.
 */
describe('AdminOrdersController — driver-assignment role wiring', () => {
  it('class-level stays ADMIN + CASHIER (unaffected by this feature)', () => {
    expect(Reflect.getMetadata(ROLES_KEY, AdminOrdersController)).toEqual(['ADMIN', 'CASHIER']);
  });

  it('assignDriver overrides to ADMIN-only (not CASHIER)', () => {
    const roles = Reflect.getMetadata(ROLES_KEY, AdminOrdersController.prototype.assignDriver);
    expect(roles).toEqual(['ADMIN']);
    expect(roles).not.toContain('CASHIER');
  });

  it('unassignDriver overrides to ADMIN-only (not CASHIER)', () => {
    const roles = Reflect.getMetadata(ROLES_KEY, AdminOrdersController.prototype.unassignDriver);
    expect(roles).toEqual(['ADMIN']);
    expect(roles).not.toContain('CASHIER');
  });
});
