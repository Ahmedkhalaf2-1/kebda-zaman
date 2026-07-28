import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Database-level integration tests for Phase 1.
 *
 * These run against the real PostgreSQL instance from docker-compose
 * (DATABASE_URL from .env) and exercise constraints/relationships that only
 * the database itself enforces: the partial unique index on User.email, the
 * quantity CHECK constraints, FK cascade/restrict behavior, and the
 * RestaurantSettings singleton guard. Every row created by a test is cleaned
 * up so the seeded dev data is left untouched.
 */
describe('Phase 1 database constraints (integration)', () => {
  const prisma = new PrismaClient();

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('User.email partial unique index (active accounts only)', () => {
    it('rejects a second active user with the same email', async () => {
      const email = `dup-${randomUUID()}@test.local`;
      const userA = await prisma.user.create({
        data: { fullName: 'Test User A', email },
      });

      await expect(
        prisma.user.create({ data: { fullName: 'Test User B', email } }),
      ).rejects.toMatchObject({ code: 'P2002' });

      await prisma.user.delete({ where: { id: userA.id } });
    });

    it('allows reusing an email once the original account is soft-deleted', async () => {
      const email = `reuse-${randomUUID()}@test.local`;
      const original = await prisma.user.create({
        data: { fullName: 'Original Account', email },
      });
      await prisma.user.update({
        where: { id: original.id },
        data: { deletedAt: new Date() },
      });

      const reregistered = await prisma.user.create({
        data: { fullName: 'Re-registered Account', email },
      });

      expect(reregistered.email).toBe(email);

      await prisma.user.deleteMany({ where: { id: { in: [original.id, reregistered.id] } } });
    });
  });

  describe('Quantity CHECK constraints', () => {
    it('rejects a CartItem with quantity 0', async () => {
      const category = await prisma.category.create({
        data: { nameAr: 'فئة اختبار', nameEn: 'Test Category' },
      });
      const menuItem = await prisma.menuItem.create({
        data: {
          categoryId: category.id,
          nameAr: 'صنف اختبار',
          nameEn: 'Test Item',
          descriptionAr: 'وصف',
          descriptionEn: 'description',
          basePrice: new Prisma.Decimal('10.00'),
          imageUrl: 'https://example.test/img.png',
        },
      });
      const cart = await prisma.cart.create({ data: {} });

      await expect(
        prisma.cartItem.create({
          data: { cartId: cart.id, menuItemId: menuItem.id, quantity: 0 },
        }),
      ).rejects.toThrow();

      // A valid quantity is accepted (proves the constraint is `>= 1`, not blanket rejection).
      const validItem = await prisma.cartItem.create({
        data: { cartId: cart.id, menuItemId: menuItem.id, quantity: 1 },
      });
      expect(validItem.quantity).toBe(1);

      await prisma.cartItem.delete({ where: { id: validItem.id } });
      await prisma.cart.delete({ where: { id: cart.id } });
      await prisma.menuItem.delete({ where: { id: menuItem.id } });
      await prisma.category.delete({ where: { id: category.id } });
    });

    it('rejects an OrderItem with quantity 0', async () => {
      const user = await prisma.user.create({ data: { fullName: 'Order Test User' } });
      const order = await prisma.order.create({
        data: {
          orderNumber: `TEST-${randomUUID()}`,
          userId: user.id,
          subtotal: new Prisma.Decimal('10.00'),
          deliveryFee: new Prisma.Decimal('0.00'),
          tax: new Prisma.Decimal('0.00'),
          discount: new Prisma.Decimal('0.00'),
          totalAmount: new Prisma.Decimal('10.00'),
          deliveryMethod: 'PICKUP',
          paymentMethod: 'CASH',
          deliveryAddressJson: { note: 'test' },
        },
      });

      await expect(
        prisma.orderItem.create({
          data: {
            orderId: order.id,
            quantity: 0,
            unitPrice: new Prisma.Decimal('10.00'),
            lineTotal: new Prisma.Decimal('0.00'),
            nameArSnapshot: 'صنف',
            nameEnSnapshot: 'Item',
          },
        }),
      ).rejects.toThrow();

      await prisma.order.delete({ where: { id: order.id } });
      await prisma.user.delete({ where: { id: user.id } });
    });
  });

  describe('Cart.userId uniqueness (one cart per user, guest carts unrestricted)', () => {
    it('rejects a second cart for the same user', async () => {
      const user = await prisma.user.create({ data: { fullName: 'Cart Owner' } });
      const cart = await prisma.cart.create({ data: { userId: user.id } });

      await expect(prisma.cart.create({ data: { userId: user.id } })).rejects.toMatchObject({
        code: 'P2002',
      });

      await prisma.cart.delete({ where: { id: cart.id } });
      await prisma.user.delete({ where: { id: user.id } });
    });

    it('allows multiple guest carts with a null userId', async () => {
      const guestCartA = await prisma.cart.create({ data: {} });
      const guestCartB = await prisma.cart.create({ data: {} });

      expect(guestCartA.userId).toBeNull();
      expect(guestCartB.userId).toBeNull();

      await prisma.cart.deleteMany({ where: { id: { in: [guestCartA.id, guestCartB.id] } } });
    });
  });

  describe('Catalog relationships (restrict + cascade)', () => {
    it('restricts deleting a Category that still has a MenuItem', async () => {
      const category = await prisma.category.create({
        data: { nameAr: 'فئة محمية', nameEn: 'Protected Category' },
      });
      const menuItem = await prisma.menuItem.create({
        data: {
          categoryId: category.id,
          nameAr: 'صنف',
          nameEn: 'Item',
          descriptionAr: 'وصف',
          descriptionEn: 'description',
          basePrice: new Prisma.Decimal('5.00'),
          imageUrl: 'https://example.test/img.png',
        },
      });

      await expect(prisma.category.delete({ where: { id: category.id } })).rejects.toThrow();

      await prisma.menuItem.delete({ where: { id: menuItem.id } });
      await prisma.category.delete({ where: { id: category.id } });
    });

    it('cascades MenuItem delete to its ItemVariants and AddonGroups/Addons', async () => {
      const category = await prisma.category.create({
        data: { nameAr: 'فئة', nameEn: 'Cascade Category' },
      });
      const menuItem = await prisma.menuItem.create({
        data: {
          categoryId: category.id,
          nameAr: 'صنف',
          nameEn: 'Cascade Item',
          descriptionAr: 'وصف',
          descriptionEn: 'description',
          basePrice: new Prisma.Decimal('5.00'),
          imageUrl: 'https://example.test/img.png',
          variants: {
            create: [{ nameAr: 'عادي', nameEn: 'Regular', priceDelta: new Prisma.Decimal('0') }],
          },
          addonGroups: {
            create: [
              {
                titleAr: 'إضافات',
                titleEn: 'Add-ons',
                addons: {
                  create: [{ nameAr: 'إضافة', nameEn: 'Addon', price: new Prisma.Decimal('1') }],
                },
              },
            ],
          },
        },
        include: { variants: true, addonGroups: { include: { addons: true } } },
      });

      const variantId = menuItem.variants[0].id;
      const addonGroupId = menuItem.addonGroups[0].id;
      const addonId = menuItem.addonGroups[0].addons[0].id;

      await prisma.menuItem.delete({ where: { id: menuItem.id } });

      const [variant, addonGroup, addon] = await Promise.all([
        prisma.itemVariant.findUnique({ where: { id: variantId } }),
        prisma.addonGroup.findUnique({ where: { id: addonGroupId } }),
        prisma.addon.findUnique({ where: { id: addonId } }),
      ]);
      expect(variant).toBeNull();
      expect(addonGroup).toBeNull();
      expect(addon).toBeNull();

      await prisma.category.delete({ where: { id: category.id } });
    });
  });

  describe('RestaurantSettings singleton', () => {
    it('rejects inserting a second row with singleton = true', async () => {
      // The dev seed already created the one allowed row (singleton unique = true).
      await expect(
        prisma.restaurantSettings.create({
          data: {
            restaurantNameAr: 'مكرر',
            restaurantNameEn: 'Duplicate',
            phone: '+20000000000',
            addressAr: 'لا مكان',
            addressEn: 'Nowhere',
            taxRatePercent: new Prisma.Decimal('0'),
            deliveryFee: new Prisma.Decimal('0'),
            minOrderAmount: new Prisma.Decimal('0'),
            currency: 'EGP',
            workingHours: {},
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });
  });

  describe('PromoCode.code uniqueness', () => {
    it('rejects a duplicate promo code', async () => {
      const code = `TEST-${randomUUID()}`;
      const promo = await prisma.promoCode.create({
        data: { code, discountType: 'PERCENT', value: new Prisma.Decimal('10') },
      });

      await expect(
        prisma.promoCode.create({
          data: { code, discountType: 'FIXED', value: new Prisma.Decimal('5') },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });

      await prisma.promoCode.delete({ where: { id: promo.id } });
    });
  });

  describe('Order cascade delete', () => {
    it('cascades to OrderItem, OrderItemCustomization, OrderStatusHistory, and Payment', async () => {
      const user = await prisma.user.create({ data: { fullName: 'Cascade Order User' } });
      const order = await prisma.order.create({
        data: {
          orderNumber: `TEST-${randomUUID()}`,
          userId: user.id,
          subtotal: new Prisma.Decimal('20.00'),
          deliveryFee: new Prisma.Decimal('0.00'),
          tax: new Prisma.Decimal('0.00'),
          discount: new Prisma.Decimal('0.00'),
          totalAmount: new Prisma.Decimal('20.00'),
          deliveryMethod: 'PICKUP',
          paymentMethod: 'CASH',
          deliveryAddressJson: { note: 'test' },
          items: {
            create: [
              {
                quantity: 2,
                unitPrice: new Prisma.Decimal('10.00'),
                lineTotal: new Prisma.Decimal('20.00'),
                nameArSnapshot: 'صنف',
                nameEnSnapshot: 'Item',
                customizations: {
                  create: [
                    {
                      kind: 'ADDON',
                      nameArSnapshot: 'إضافة',
                      nameEnSnapshot: 'Addon',
                      priceSnapshot: new Prisma.Decimal('0'),
                    },
                  ],
                },
              },
            ],
          },
          statusHistory: { create: [{ toStatus: 'PENDING' }] },
          payments: {
            create: [
              {
                method: 'CASH',
                amount: new Prisma.Decimal('20.00'),
                currency: 'EGP',
                idempotencyKey: `TEST-${randomUUID()}`,
              },
            ],
          },
        },
        include: {
          items: { include: { customizations: true } },
          statusHistory: true,
          payments: true,
        },
      });

      const orderItemId = order.items[0].id;
      const customizationId = order.items[0].customizations[0].id;
      const statusHistoryId = order.statusHistory[0].id;
      const paymentId = order.payments[0].id;

      await prisma.order.delete({ where: { id: order.id } });

      const [orderItem, customization, statusHistory, payment] = await Promise.all([
        prisma.orderItem.findUnique({ where: { id: orderItemId } }),
        prisma.orderItemCustomization.findUnique({ where: { id: customizationId } }),
        prisma.orderStatusHistory.findUnique({ where: { id: statusHistoryId } }),
        prisma.payment.findUnique({ where: { id: paymentId } }),
      ]);
      expect(orderItem).toBeNull();
      expect(customization).toBeNull();
      expect(statusHistory).toBeNull();
      expect(payment).toBeNull();

      await prisma.user.delete({ where: { id: user.id } });
    });
  });
});
