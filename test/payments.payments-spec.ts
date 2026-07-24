import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma, PaymentMethod, PaymentStatus } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { AuthService } from '../src/modules/auth/auth.service';
import { CashOnDeliveryProvider } from '../src/modules/payments/providers/cash.provider';
import { UnconfiguredGatewayProvider } from '../src/modules/payments/providers/unconfigured.provider';
import {
  PAYMENT_PROVIDERS,
  ParsedWebhookEvent,
  PaymentIntentResult,
  PaymentProvider,
  WebhookVerificationResult,
} from '../src/modules/payments/payment-provider.interface';

const D = (v: string) => new Prisma.Decimal(v);

/**
 * Test-only webhook-capable provider used to exercise the idempotent
 * webhook-processing architecture end-to-end. Registered ONLY via a DI
 * override of PAYMENT_PROVIDERS for this test app instance — production
 * wiring (payments.module.ts) never includes it, so no fake gateway is ever
 * exposed outside tests.
 */
class FakeGatewayTestProvider implements PaymentProvider {
  readonly name = 'test_gateway';
  readonly methods: PaymentMethod[] = [];
  readonly isConfigured = true;

  async createIntent(): Promise<PaymentIntentResult> {
    throw new Error('not used in these tests');
  }

  verifyWebhook(): WebhookVerificationResult {
    return { valid: true };
  }

  parseWebhook(rawBody: string): ParsedWebhookEvent {
    const parsed = JSON.parse(rawBody) as { providerRef: string; status: PaymentStatus };
    return { providerRef: parsed.providerRef, status: parsed.status };
  }
}

describe('Payments (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authService: AuthService;

  let categoryId: string;
  let menuItemId: string;
  const cleanupUserIds: string[] = [];

  async function registerCustomer() {
    const registered = await authService.register(
      {
        name: 'Payments Customer',
        email: `pay-customer-${randomUUID()}@phase8.local`,
        password: 'correcthorsebattery',
      },
      {},
    );
    cleanupUserIds.push(registered.user.id);
    return registered;
  }

  async function registerAdmin() {
    const registered = await authService.register(
      {
        name: 'Payments Admin',
        email: `pay-admin-${randomUUID()}@phase8.local`,
        password: 'correcthorsebattery',
      },
      {},
    );
    cleanupUserIds.push(registered.user.id);
    await prisma.user.update({ where: { id: registered.user.id }, data: { role: 'ADMIN' } });
    return authService.login(
      { email: registered.user.email as string, password: 'correcthorsebattery' },
      {},
    );
  }

  async function checkout(accessToken: string, paymentMethod: PaymentMethod) {
    await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ menuItemId, quantity: 1 });

    const res = await request(app.getHttpServer())
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ deliveryMethod: 'PICKUP', paymentMethod });
    expect(res.status).toBe(201);
    return res.body as { id: string; totalAmount: number };
  }

  async function advanceToDelivered(orderId: string, adminToken: string) {
    for (const status of ['confirmed', 'preparing', 'outForDelivery', 'delivered']) {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${orderId}/status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status });
      expect(res.status).toBe(200);
    }
  }

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PAYMENT_PROVIDERS)
      .useFactory({
        factory: (cash: CashOnDeliveryProvider): PaymentProvider[] => [
          cash,
          new UnconfiguredGatewayProvider('CARD'),
          new UnconfiguredGatewayProvider('WALLET'),
          new FakeGatewayTestProvider(),
        ],
        inject: [CashOnDeliveryProvider],
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = app.get(PrismaService);
    authService = app.get(AuthService);

    const category = await prisma.category.create({
      data: { nameAr: 'فئة المدفوعات', nameEn: 'Phase 8 Payments Category' },
    });
    categoryId = category.id;
    const item = await prisma.menuItem.create({
      data: {
        categoryId,
        nameAr: 'صنف الدفع',
        nameEn: 'Payments Item',
        descriptionAr: 'وصف',
        descriptionEn: 'description',
        basePrice: D('75.00'),
        imageUrl: 'https://example.test/img.png',
      },
    });
    menuItemId = item.id;
  });

  afterAll(async () => {
    await prisma.payment.deleteMany({ where: { order: { userId: { in: cleanupUserIds } } } });
    await prisma.orderStatusHistory.deleteMany({
      where: { order: { userId: { in: cleanupUserIds } } },
    });
    await prisma.orderItemCustomization.deleteMany({
      where: { orderItem: { order: { userId: { in: cleanupUserIds } } } },
    });
    await prisma.orderItem.deleteMany({ where: { order: { userId: { in: cleanupUserIds } } } });
    await prisma.order.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
    await prisma.menuItem.deleteMany({ where: { categoryId } });
    await prisma.category.delete({ where: { id: categoryId } });
    await app.close();
  });

  // ===========================================================================
  describe('CASH flow end-to-end', () => {
    it('checkout creates a PENDING cash Payment; intent is a no-op instructions payload; delivery settles it to PAID', async () => {
      const customer = await registerCustomer();
      const admin = await registerAdmin();
      const order = await checkout(customer.accessToken, 'CASH');

      const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });
      expect(payment.method).toBe('CASH');
      expect(payment.status).toBe('PENDING');

      const intentRes = await request(app.getHttpServer())
        .post('/api/v1/payments/intent')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ orderId: order.id });
      expect(intentRes.status).toBe(201);
      expect(intentRes.body.paymentId).toBe(payment.id);
      expect(intentRes.body.status).toBe('PENDING');
      expect(intentRes.body.providerData.instructions).toMatch(/cash/i);

      await advanceToDelivered(order.id, admin.accessToken);

      const settled = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      expect(settled.status).toBe('PAID');
      const settledOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(settledOrder.paymentStatus).toBe('PAID');
    });
  });

  // ===========================================================================
  describe('Authoritative payment amount', () => {
    it('persists the server-computed order total, never a client-supplied amount', async () => {
      const customer = await registerCustomer();
      const order = await checkout(customer.accessToken, 'CASH');

      const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });
      expect(payment.amount.toNumber()).toBe(order.totalAmount);
      expect(order.totalAmount).toBeGreaterThan(75); // 1 x 75.00 base + server-applied tax
    });
  });

  // ===========================================================================
  describe('Ownership / security', () => {
    it("a non-owner customer cannot fetch another customer's payment (404, not leaked)", async () => {
      const owner = await registerCustomer();
      const intruder = await registerCustomer();
      const order = await checkout(owner.accessToken, 'CASH');
      const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });

      const res = await request(app.getHttpServer())
        .get(`/api/v1/payments/${payment.id}`)
        .set('Authorization', `Bearer ${intruder.accessToken}`);
      expect(res.status).toBe(404);
    });

    it("a non-owner cannot create an intent for someone else's order", async () => {
      const owner = await registerCustomer();
      const intruder = await registerCustomer();
      const order = await checkout(owner.accessToken, 'CASH');

      const res = await request(app.getHttpServer())
        .post('/api/v1/payments/intent')
        .set('Authorization', `Bearer ${intruder.accessToken}`)
        .send({ orderId: order.id });
      expect(res.status).toBe(404);
    });

    it('ADMIN can fetch any payment', async () => {
      const customer = await registerCustomer();
      const admin = await registerAdmin();
      const order = await checkout(customer.accessToken, 'CASH');
      const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });

      const res = await request(app.getHttpServer())
        .get(`/api/v1/payments/${payment.id}`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(payment.id);
    });

    it('rejects an unauthenticated caller with 401', async () => {
      const res = await request(app.getHttpServer()).get(`/api/v1/payments/${randomUUID()}`);
      expect(res.status).toBe(401);
    });
  });

  // ===========================================================================
  describe('Duplicate / idempotent intent processing', () => {
    it('repeated intent calls while PENDING never create a second Payment row', async () => {
      const customer = await registerCustomer();
      const order = await checkout(customer.accessToken, 'CASH');

      await request(app.getHttpServer())
        .post('/api/v1/payments/intent')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ orderId: order.id });
      await request(app.getHttpServer())
        .post('/api/v1/payments/intent')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ orderId: order.id });

      const count = await prisma.payment.count({ where: { orderId: order.id } });
      expect(count).toBe(1);
    });

    it('rejects creating an intent for an already-processed payment (409)', async () => {
      const customer = await registerCustomer();
      const order = await checkout(customer.accessToken, 'CASH');
      const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });
      await prisma.payment.update({ where: { id: payment.id }, data: { status: 'PAID' } });

      const res = await request(app.getHttpServer())
        .post('/api/v1/payments/intent')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ orderId: order.id });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PAYMENT_ALREADY_PROCESSED');
    });
  });

  // ===========================================================================
  describe('CARD/WALLET: provider not configured', () => {
    it.each(['CARD', 'WALLET'] as const)(
      '%s intent creation fails clearly and never marks the payment PAID',
      async (method) => {
        const customer = await registerCustomer();
        const order = await checkout(customer.accessToken, method);
        const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });

        const res = await request(app.getHttpServer())
          .post('/api/v1/payments/intent')
          .set('Authorization', `Bearer ${customer.accessToken}`)
          .send({ orderId: order.id });
        expect(res.status).toBe(501);
        expect(res.body.code).toBe('PAYMENT_PROVIDER_NOT_CONFIGURED');

        const unchanged = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
        expect(unchanged.status).toBe('PENDING');
      },
    );
  });

  // ===========================================================================
  describe('Webhook architecture: routing, signature, idempotency', () => {
    it('rejects an unknown provider with 400', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/payments/webhook')
        .query({ provider: 'unknown_gateway' })
        .send({ providerRef: 'x', status: 'PAID' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('UNKNOWN_PAYMENT_PROVIDER');
    });

    it('rejects the real cash provider (never accepts webhooks) with 400', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/payments/webhook')
        .query({ provider: 'cod' })
        .send({ providerRef: 'x', status: 'PAID' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_WEBHOOK_SIGNATURE');
    });

    it('rejects the unconfigured card gateway placeholder with 400 (no fake success)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/payments/webhook')
        .query({ provider: 'card_gateway' })
        .send({ providerRef: 'x', status: 'PAID' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_WEBHOOK_SIGNATURE');
    });

    it('applies a valid webhook exactly once and is idempotent on retry', async () => {
      const customer = await registerCustomer();
      const order = await checkout(customer.accessToken, 'CARD');
      const providerRef = `test-ref-${randomUUID()}`;
      const fakePayment = await prisma.payment.create({
        data: {
          orderId: order.id,
          method: 'CARD',
          status: 'PENDING',
          amount: D('75.00'),
          currency: 'EGP',
          idempotencyKey: `webhook-test-${randomUUID()}`,
          providerRef,
        },
      });

      const first = await request(app.getHttpServer())
        .post('/api/v1/payments/webhook')
        .query({ provider: 'test_gateway' })
        .send({ providerRef, status: 'PAID' });
      expect(first.status).toBe(200);

      const afterFirst = await prisma.payment.findUniqueOrThrow({ where: { id: fakePayment.id } });
      expect(afterFirst.status).toBe('PAID');
      const orderAfterFirst = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(orderAfterFirst.paymentStatus).toBe('PAID');

      // Duplicate delivery of the same event — must not error and must stay PAID.
      const second = await request(app.getHttpServer())
        .post('/api/v1/payments/webhook')
        .query({ provider: 'test_gateway' })
        .send({ providerRef, status: 'PAID' });
      expect(second.status).toBe(200);
      const afterSecond = await prisma.payment.findUniqueOrThrow({ where: { id: fakePayment.id } });
      expect(afterSecond.status).toBe('PAID');
    });

    it('two concurrent identical webhooks for the same PENDING payment settle it exactly once', async () => {
      const customer = await registerCustomer();
      const order = await checkout(customer.accessToken, 'CARD');
      const providerRef = `test-ref-${randomUUID()}`;
      const fakePayment = await prisma.payment.create({
        data: {
          orderId: order.id,
          method: 'CARD',
          status: 'PENDING',
          amount: D('75.00'),
          currency: 'EGP',
          idempotencyKey: `webhook-race-${randomUUID()}`,
          providerRef,
        },
      });

      const send = () =>
        request(app.getHttpServer())
          .post('/api/v1/payments/webhook')
          .query({ provider: 'test_gateway' })
          .send({ providerRef, status: 'PAID' });
      const [a, b] = await Promise.all([send(), send()]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);

      const final = await prisma.payment.findUniqueOrThrow({ where: { id: fakePayment.id } });
      expect(final.status).toBe('PAID');
    });

    it('ignores an invalid transition (PAID -> PENDING) instead of applying it', async () => {
      const customer = await registerCustomer();
      const order = await checkout(customer.accessToken, 'CARD');
      const providerRef = `test-ref-${randomUUID()}`;
      await prisma.payment.create({
        data: {
          orderId: order.id,
          method: 'CARD',
          status: 'PAID',
          amount: D('75.00'),
          currency: 'EGP',
          idempotencyKey: `webhook-invalid-${randomUUID()}`,
          providerRef,
        },
      });

      const res = await request(app.getHttpServer())
        .post('/api/v1/payments/webhook')
        .query({ provider: 'test_gateway' })
        .send({ providerRef, status: 'PENDING' });
      expect(res.status).toBe(200); // acknowledged, but not applied

      const unchanged = await prisma.payment.findFirstOrThrow({ where: { providerRef } });
      expect(unchanged.status).toBe('PAID');
    });

    it('404s a webhook for an unknown providerRef', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/payments/webhook')
        .query({ provider: 'test_gateway' })
        .send({ providerRef: `nonexistent-${randomUUID()}`, status: 'PAID' });
      expect(res.status).toBe(404);
    });
  });
});
