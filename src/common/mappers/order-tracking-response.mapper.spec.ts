import { Prisma } from '@prisma/client';
import {
  OrderTrackingSource,
  TRACKING_FRESHNESS_THRESHOLD_SECONDS,
  toOrderTrackingResponse,
} from './order-tracking-response.mapper';

const D = (v: number) => ({ toNumber: () => v }) as unknown as Prisma.Decimal;

function locationSample(overrides: Partial<OrderTrackingSource['driverLocation']> = {}) {
  return {
    orderId: 'order-1',
    driverId: 'driver-1',
    assignmentVersion: 3,
    latitude: D(21.5433),
    longitude: D(39.1728),
    accuracyMeters: D(12),
    headingDegrees: D(90),
    speedMps: D(5),
    capturedAt: new Date(),
    receivedAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as OrderTrackingSource['driverLocation'];
}

function source(overrides: Partial<OrderTrackingSource> = {}): OrderTrackingSource {
  return {
    status: 'OUT_FOR_DELIVERY',
    driverId: 'driver-1',
    driverAssignmentVersion: 3,
    driver: { fullName: 'Ahmed Driver', phone: '0500000000', deletedAt: null },
    driverLocation: locationSample(),
    ...overrides,
  };
}

describe('toOrderTrackingResponse', () => {
  const NOW = new Date('2026-01-01T12:00:00.000Z');

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each(['PENDING', 'CONFIRMED', 'PREPARING', 'READY_FOR_PICKUP'])(
    'NOT_STARTED for a %s order (never reached OUT_FOR_DELIVERY)',
    (status) => {
      const dto = toOrderTrackingResponse('order-1', source({ status: status as never }));
      expect(dto.state).toBe('NOT_STARTED');
      expect(dto.driverName).toBeNull();
      expect(dto.location).toBeNull();
    },
  );

  it.each(['DELIVERED', 'PICKED_UP', 'CANCELLED'])('ENDED for a terminal %s order', (status) => {
    const dto = toOrderTrackingResponse('order-1', source({ status: status as never }));
    expect(dto.state).toBe('ENDED');
    expect(dto.driverName).toBeNull();
    expect(dto.location).toBeNull();
  });

  it('ENDED when OUT_FOR_DELIVERY but unassigned mid-delivery', () => {
    const dto = toOrderTrackingResponse(
      'order-1',
      source({ driverId: null, driver: null, driverLocation: null }),
    );
    expect(dto.state).toBe('ENDED');
    expect(dto.location).toBeNull();
  });

  it('ENDED when the assigned driver has been deactivated', () => {
    const dto = toOrderTrackingResponse(
      'order-1',
      source({ driver: { fullName: 'Ahmed Driver', phone: '0500000000', deletedAt: NOW } }),
    );
    expect(dto.state).toBe('ENDED');
    expect(dto.driverName).toBeNull();
    expect(dto.location).toBeNull();
  });

  it('WAITING_FOR_LOCATION when no location sample exists yet', () => {
    const dto = toOrderTrackingResponse('order-1', source({ driverLocation: null }));
    expect(dto.state).toBe('WAITING_FOR_LOCATION');
    expect(dto.driverName).toBe('Ahmed Driver'); // driver info IS shown here
    expect(dto.location).toBeNull();
  });

  it('WAITING_FOR_LOCATION when the stored sample belongs to a DIFFERENT assignment version', () => {
    const dto = toOrderTrackingResponse(
      'order-1',
      source({
        driverAssignmentVersion: 4,
        driverLocation: locationSample({ assignmentVersion: 3, capturedAt: NOW }),
      }),
    );
    expect(dto.state).toBe('WAITING_FOR_LOCATION');
    expect(dto.location).toBeNull(); // never leaks the old assignment's coordinates
  });

  it('ACTIVE when the sample is within the freshness threshold', () => {
    const capturedAt = new Date(NOW.getTime() - (TRACKING_FRESHNESS_THRESHOLD_SECONDS - 1) * 1000);
    const dto = toOrderTrackingResponse(
      'order-1',
      source({ driverLocation: locationSample({ capturedAt }) }),
    );
    expect(dto.state).toBe('ACTIVE');
    expect(dto.location).not.toBeNull();
    expect(dto.location?.latitude).toBeCloseTo(21.5433);
    expect(dto.locationAgeSeconds).toBe(TRACKING_FRESHNESS_THRESHOLD_SECONDS - 1);
  });

  it('STALE when the sample is older than the freshness threshold — coordinates are still returned', () => {
    const capturedAt = new Date(NOW.getTime() - (TRACKING_FRESHNESS_THRESHOLD_SECONDS + 30) * 1000);
    const dto = toOrderTrackingResponse(
      'order-1',
      source({ driverLocation: locationSample({ capturedAt }) }),
    );
    expect(dto.state).toBe('STALE');
    expect(dto.location).not.toBeNull(); // real coordinates, just labeled STALE
    expect(dto.location?.capturedAt).toBe(capturedAt.toISOString());
    expect(dto.locationAgeSeconds).toBe(TRACKING_FRESHNESS_THRESHOLD_SECONDS + 30);
  });

  it('driverPhone/driverName are null before the delivery starts and after it ends, never before', () => {
    const notStarted = toOrderTrackingResponse('order-1', source({ status: 'PREPARING' }));
    expect(notStarted.driverPhone).toBeNull();

    const ended = toOrderTrackingResponse('order-1', source({ status: 'DELIVERED' }));
    expect(ended.driverPhone).toBeNull();

    const active = toOrderTrackingResponse('order-1', source());
    expect(active.driverPhone).toBe('0500000000');
  });
});
