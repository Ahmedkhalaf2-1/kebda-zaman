import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SetPreparationTimeDto } from './set-preparation-time.dto';

/**
 * Mirrors the app's global ValidationPipe (main.ts: whitelist,
 * forbidNonWhitelisted, transform, enableImplicitConversion) so these
 * results match what actually happens on the wire.
 */
async function validateBody(body: unknown) {
  const dto = plainToInstance(SetPreparationTimeDto, body, { enableImplicitConversion: true });
  return validate(dto, { whitelist: true, forbidNonWhitelisted: true });
}

describe('SetPreparationTimeDto', () => {
  it('accepts a preset value (20)', async () => {
    expect(await validateBody({ minutes: 20 })).toHaveLength(0);
  });

  it('accepts the minimum boundary (1)', async () => {
    expect(await validateBody({ minutes: 1 })).toHaveLength(0);
  });

  it('accepts the maximum boundary (180)', async () => {
    expect(await validateBody({ minutes: 180 })).toHaveLength(0);
  });

  it('rejects minutes below 1', async () => {
    const errors = await validateBody({ minutes: 0 });
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('min');
  });

  it('rejects a negative value', async () => {
    const errors = await validateBody({ minutes: -5 });
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('min');
  });

  it('rejects minutes above 180', async () => {
    const errors = await validateBody({ minutes: 181 });
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('max');
  });

  it('rejects a non-integer value', async () => {
    const errors = await validateBody({ minutes: 20.5 });
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('isInt');
  });

  it('rejects a missing minutes field', async () => {
    const errors = await validateBody({});
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('minutes');
  });

  it('never accepts an absolute ETA/timestamp field from the client (forbidNonWhitelisted, matching main.ts)', async () => {
    const errors = await validateBody({
      minutes: 20,
      estimatedDeliveryTime: '2099-01-01T00:00:00.000Z',
    });
    expect(errors.some((e) => e.property === 'estimatedDeliveryTime')).toBe(true);
  });
});
