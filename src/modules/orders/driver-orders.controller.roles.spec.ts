import 'reflect-metadata';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { DriverOrdersController } from './driver-orders.controller';

/**
 * Every route on this controller must stay DRIVER-only (class-level
 * @Roles('DRIVER'), no method-level override) — a customer, admin, cashier or
 * kitchen principal must never reach a driver's delivery actions, including
 * the Phase 2 location-upload route.
 */
describe('DriverOrdersController — role wiring', () => {
  it('is restricted to DRIVER at the class level', () => {
    expect(Reflect.getMetadata(ROLES_KEY, DriverOrdersController)).toEqual(['DRIVER']);
  });

  it.each([
    'listActive',
    'listHistory',
    'getOrder',
    'pickup',
    'delivered',
    'recordLocation',
  ] as const)(
    '%s has no method-level override — falls back to class-level DRIVER-only',
    (method) => {
      expect(
        Reflect.getMetadata(ROLES_KEY, DriverOrdersController.prototype[method]),
      ).toBeUndefined();
    },
  );

  it('recordLocation (PUT :id/location) carries its own throttle limit, higher than the global default', () => {
    const limit = Reflect.getMetadata(
      'THROTTLER:LIMITdefault',
      DriverOrdersController.prototype.recordLocation,
    );
    expect(limit).toBe(60);
  });
});
