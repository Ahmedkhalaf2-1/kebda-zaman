import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { AuthService } from '../src/modules/auth/auth.service';

/**
 * Phase 2 integration tests: a real Nest app (same pipeline as main.ts,
 * minus helmet/cors) against the live Docker PostgreSQL instance. Every
 * created user is deleted in afterAll (RefreshToken rows cascade).
 */
describe('Auth & Users (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authService: AuthService;
  const createdUserIds: string[] = [];

  function uniqueEmail(label: string): string {
    return `${label}-${randomUUID()}@auth-test.local`;
  }

  /**
   * Test fixture helper: creates a user via the AuthService directly (not
   * over HTTP), so the many tests that just need "a registered user" as setup
   * don't consume the /auth/register route's rate-limit budget — that budget
   * is reserved for tests that specifically exercise the register endpoint's
   * HTTP contract (see "Registration", "DTO validation", "Rate limiting").
   */
  async function registerUser(
    overrides: Partial<{ name: string; email: string; password: string }> = {},
  ) {
    const name = overrides.name ?? 'Test User';
    const email = overrides.email ?? uniqueEmail('user');
    const password = overrides.password ?? 'correcthorsebattery';
    const result = await authService.register({ name, email, password }, {});
    createdUserIds.push(result.user.id);
    return { ...result, plainPassword: password, email } as {
      user: { id: string; email: string; role: string };
      accessToken: string;
      refreshToken: string;
      plainPassword: string;
      email: string;
    };
  }

  async function promoteToAdmin(userId: string): Promise<void> {
    await prisma.user.update({ where: { id: userId }, data: { role: 'ADMIN' } });
  }

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

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
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
  });

  // -------------------------------------------------------------------------
  describe('Registration', () => {
    it('succeeds and returns user + tokens, with no password material exposed', async () => {
      const email = uniqueEmail('register-success');
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ name: 'Register Success', email, password: 'correcthorsebattery' });

      expect(res.status).toBe(201);
      expect(res.body.user).toMatchObject({
        name: 'Register Success',
        email,
        role: 'CUSTOMER',
        isGuest: false,
      });
      expect(res.body.user).not.toHaveProperty('passwordHash');
      expect(typeof res.body.accessToken).toBe('string');
      expect(typeof res.body.refreshToken).toBe('string');
      createdUserIds.push(res.body.user.id);
    });

    it('rejects a duplicate email with 409 EMAIL_ALREADY_EXISTS', async () => {
      const { email } = await registerUser();
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ name: 'Duplicate', email, password: 'anotherpassword1' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('EMAIL_ALREADY_EXISTS');
    });

    it('stores an argon2id hash, never the plaintext password', async () => {
      const plainPassword = 'correcthorsebattery';
      const { user } = await registerUser({ password: plainPassword });
      const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });

      expect(row.passwordHash).not.toBeNull();
      expect(row.passwordHash).not.toBe(plainPassword);
      expect(row.passwordHash?.startsWith('$argon2id$')).toBe(true);
    });

    it('accepts the /auth/signup alias', async () => {
      const email = uniqueEmail('signup-alias');
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/signup')
        .send({ name: 'Alias', email, password: 'correcthorsebattery' });
      expect(res.status).toBe(201);
      createdUserIds.push(res.body.user.id);
    });
  });

  // -------------------------------------------------------------------------
  describe('Customer login', () => {
    it('succeeds with correct credentials', async () => {
      const { email, plainPassword } = await registerUser();
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: plainPassword });
      expect(res.status).toBe(200);
      expect(res.body.user.email).toBe(email);
      expect(typeof res.body.accessToken).toBe('string');
    });

    it('rejects a wrong password with generic 401 INVALID_CREDENTIALS', async () => {
      const { email } = await registerUser();
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: 'the-wrong-password' });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('INVALID_CREDENTIALS');
    });

    it('rejects an unknown email with the SAME generic error (no account enumeration)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: uniqueEmail('never-registered'), password: 'whatever12345' });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('INVALID_CREDENTIALS');
      expect(res.body.message).toBe('Invalid email or password');
    });
  });

  // -------------------------------------------------------------------------
  describe('Admin login', () => {
    it('succeeds for a promoted ADMIN user on both the primary and alias paths', async () => {
      const { user, email, plainPassword } = await registerUser();
      await promoteToAdmin(user.id);

      const primary = await request(app.getHttpServer())
        .post('/api/v1/admin/auth/login')
        .send({ email, password: plainPassword });
      expect(primary.status).toBe(200);
      expect(primary.body.user.role).toBe('ADMIN');

      const alias = await request(app.getHttpServer())
        .post('/api/v1/auth/admin/login')
        .send({ email, password: plainPassword });
      expect(alias.status).toBe(200);
      expect(alias.body.user.role).toBe('ADMIN');
    });

    it('rejects a correctly-authenticated non-admin with 403 NOT_ADMIN', async () => {
      const { email, plainPassword } = await registerUser();
      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/auth/login')
        .send({ email, password: plainPassword });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NOT_ADMIN');
    });

    it('rejects wrong credentials with generic 401, not 403', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/auth/login')
        .send({ email: uniqueEmail('no-such-admin'), password: 'whatever12345' });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('INVALID_CREDENTIALS');
    });
  });

  // -------------------------------------------------------------------------
  describe('Protected route access (JwtAccessGuard)', () => {
    it('allows access with a valid access token', async () => {
      const { accessToken } = await registerUser();
      const res = await request(app.getHttpServer())
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${accessToken}`);
      expect(res.status).toBe(200);
    });

    it('rejects a missing token with 401 UNAUTHORIZED', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/users/me');
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
    });

    it('rejects an invalid/malformed token with 401 INVALID_TOKEN', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/users/me')
        .set('Authorization', 'Bearer not-a-real-jwt');
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('INVALID_TOKEN');
    });

    it('allows public routes (health) with no token at all', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/health');
      expect(res.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  describe('Refresh rotation & reuse detection', () => {
    it('refresh succeeds and rotates to a new token pair', async () => {
      const { refreshToken } = await registerUser();
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken });
      expect(res.status).toBe(200);
      expect(typeof res.body.accessToken).toBe('string');
      expect(res.body.refreshToken).not.toBe(refreshToken);
    });

    it('marks the old token revoked and links replacedByTokenId to the new row', async () => {
      const { refreshToken: oldToken, user } = await registerUser();
      const before = await prisma.refreshToken.findMany({ where: { userId: user.id } });
      expect(before).toHaveLength(1);

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: oldToken });
      expect(res.status).toBe(200);

      const rows = await prisma.refreshToken.findMany({ where: { userId: user.id } });
      expect(rows).toHaveLength(2);
      const oldRow = rows.find((r) => r.id === before[0].id)!;
      expect(oldRow.revokedAt).not.toBeNull();
      expect(oldRow.replacedByTokenId).not.toBeNull();
      // Rotation stays within the same session lineage.
      const newRow = rows.find((r) => r.id === oldRow.replacedByTokenId)!;
      expect(newRow.familyId).toBe(oldRow.familyId);
    });

    it('rejects the old token once it has been rotated away', async () => {
      const { refreshToken: oldToken } = await registerUser();
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: oldToken });

      const reuse = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: oldToken });
      expect(reuse.status).toBe(401);
      expect(reuse.body.code).toBe('REFRESH_TOKEN_REUSED');
    });

    it('revokes the entire family on reuse, so even the never-used latest token is rejected', async () => {
      const { refreshToken: tokenA } = await registerUser();
      const rotated = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: tokenA });
      const tokenB = rotated.body.refreshToken as string;

      // Reuse the old, already-rotated token A -> triggers family-wide revocation.
      const reuse = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: tokenA });
      expect(reuse.status).toBe(401);
      expect(reuse.body.code).toBe('REFRESH_TOKEN_REUSED');

      // Token B was never itself reused, but its whole family was revoked.
      const usingB = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: tokenB });
      expect(usingB.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  describe('Expired / manually revoked refresh tokens', () => {
    it('rejects an expired (never-rotated) refresh token with REFRESH_TOKEN_EXPIRED', async () => {
      const { refreshToken, user } = await registerUser();
      await prisma.refreshToken.updateMany({
        where: { userId: user.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('REFRESH_TOKEN_EXPIRED');
    });

    it('rejects a manually revoked refresh token as reuse', async () => {
      const { refreshToken, user } = await registerUser();
      await prisma.refreshToken.updateMany({
        where: { userId: user.id },
        data: { revokedAt: new Date() },
      });

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('REFRESH_TOKEN_REUSED');
    });

    it('rejects an unknown/garbage refresh token', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: 'this-token-was-never-issued' });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('INVALID_REFRESH_TOKEN');
    });
  });

  // -------------------------------------------------------------------------
  describe('Logout', () => {
    it('revokes the presented refresh token and returns 204', async () => {
      const { accessToken, refreshToken, user } = await registerUser();

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ refreshToken });
      expect(res.status).toBe(204);

      const row = await prisma.refreshToken.findFirst({ where: { userId: user.id } });
      expect(row?.revokedAt).not.toBeNull();

      const afterLogout = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken });
      expect(afterLogout.status).toBe(401);
    });

    it('requires authentication (401 without an access token)', async () => {
      const res = await request(app.getHttpServer()).post('/api/v1/auth/logout').send({});
      expect(res.status).toBe(401);
    });
  });

  describe('Logout-all', () => {
    it('revokes every active session for the user (multiple devices)', async () => {
      const {
        accessToken,
        refreshToken: sessionA,
        email,
        plainPassword,
        user,
      } = await registerUser();

      // A second login = a second independent device session (new token family).
      const secondLogin = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: plainPassword });
      expect(secondLogin.status).toBe(200);
      const sessionB = secondLogin.body.refreshToken as string;

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/logout-all')
        .set('Authorization', `Bearer ${accessToken}`)
        .send();
      expect(res.status).toBe(204);

      const rows = await prisma.refreshToken.findMany({ where: { userId: user.id } });
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(rows.every((r) => r.revokedAt !== null)).toBe(true);

      const refreshA = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: sessionA });
      expect(refreshA.status).toBe(401);

      const refreshB = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: sessionB });
      expect(refreshB.status).toBe(401);
    });

    it('requires authentication (401 without an access token)', async () => {
      const res = await request(app.getHttpServer()).post('/api/v1/auth/logout-all').send();
      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  describe('Guest session', () => {
    it('creates a guest user and issues usable tokens', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/guest')
        .send({ deviceId: 'test-device-123' });
      expect(res.status).toBe(201);
      expect(res.body.user.isGuest).toBe(true);
      expect(res.body.user.email).toBeNull();
      createdUserIds.push(res.body.user.id);

      const me = await request(app.getHttpServer())
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${res.body.accessToken}`);
      expect(me.status).toBe(200);
      expect(me.body.isGuest).toBe(true);
    });

    it('works with no body at all (deviceId is optional)', async () => {
      const res = await request(app.getHttpServer()).post('/api/v1/auth/guest').send();
      expect(res.status).toBe(201);
      createdUserIds.push(res.body.user.id);
    });
  });

  // -------------------------------------------------------------------------
  describe('GET/PATCH /users/me', () => {
    it('GET returns the current user profile shaped for the frontend (name, not fullName)', async () => {
      const { accessToken, user } = await registerUser({ name: 'Profile Owner' });
      const res = await request(app.getHttpServer())
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(user.id);
      expect(res.body.name).toBe('Profile Owner');
      expect(res.body).not.toHaveProperty('fullName');
      expect(res.body).not.toHaveProperty('passwordHash');
    });

    it('PATCH partially updates the profile', async () => {
      const { accessToken } = await registerUser({ name: 'Before Update' });
      const res = await request(app.getHttpServer())
        .patch('/api/v1/users/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: 'After Update', locale: 'ar' });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('After Update');
      expect(res.body.locale).toBe('ar');
    });

    it('rejects an invalid locale value', async () => {
      const { accessToken } = await registerUser();
      const res = await request(app.getHttpServer())
        .patch('/api/v1/users/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ locale: 'fr' });
      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  describe('DTO validation', () => {
    it('rejects registration with an invalid email', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ name: 'Bad Email', email: 'not-an-email', password: 'correcthorsebattery' });
      expect(res.status).toBe(400);
    });

    it('rejects registration with a too-short password', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ name: 'Short Pw', email: uniqueEmail('short-pw'), password: 'short' });
      expect(res.status).toBe(400);
    });

    it('rejects registration missing required fields', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email: uniqueEmail('missing-fields') });
      expect(res.status).toBe(400);
    });

    it('rejects unknown extra fields (forbidNonWhitelisted)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({
          name: 'Extra Field',
          email: uniqueEmail('extra-field'),
          password: 'correcthorsebattery',
          role: 'ADMIN',
        });
      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  describe('Brute-force lockout', () => {
    it('locks out after repeated failed logins, regardless of subsequent correct credentials', async () => {
      const { email, plainPassword } = await registerUser();

      for (let i = 0; i < 5; i += 1) {
        const res = await request(app.getHttpServer())
          .post('/api/v1/auth/login')
          .send({ email, password: 'still-wrong-password' });
        expect(res.status).toBe(401);
      }

      const locked = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: plainPassword });
      expect(locked.status).toBe(423);
      expect(locked.body.code).toBe('ACCOUNT_LOCKED');
    });
  });

  // -------------------------------------------------------------------------
  // Uses its own freshly-booted app (fresh in-memory ThrottlerStorage) so this
  // burst neither depends on nor pollutes the shared `app`'s throttle counters.
  describe('Rate limiting (isolated app instance)', () => {
    let throttleApp: INestApplication;
    let throttlePrisma: PrismaService;
    const throttleCreatedIds: string[] = [];

    beforeAll(async () => {
      const moduleRef: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      throttleApp = moduleRef.createNestApplication();
      throttleApp.setGlobalPrefix('api');
      throttleApp.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
      throttleApp.useGlobalPipes(
        new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
      );
      throttleApp.useGlobalFilters(new AllExceptionsFilter());
      await throttleApp.init();
      throttlePrisma = throttleApp.get(PrismaService);
    });

    afterAll(async () => {
      if (throttleCreatedIds.length > 0) {
        await throttlePrisma.user.deleteMany({ where: { id: { in: throttleCreatedIds } } });
      }
      await throttleApp.close();
    });

    it('returns 429 once the per-route auth throttle is exceeded', async () => {
      const responses = [];
      for (let i = 0; i < 25; i += 1) {
        responses.push(
          await request(throttleApp.getHttpServer())
            .post('/api/v1/auth/register')
            .send({
              name: 'Throttle',
              email: uniqueEmail(`throttle-${i}`),
              password: 'correcthorsebattery',
            }),
        );
      }
      responses
        .filter((r) => r.status === 201)
        .forEach((r) => throttleCreatedIds.push(r.body.user.id));

      expect(responses.some((r) => r.status === 429)).toBe(true);
    });
  });
});
