import { PasswordService } from './password.service';

// Argon2id hashing is intentionally memory/CPU-hard; under parallel Jest
// workers this can exceed the default 5s test timeout, so it's raised here
// rather than weakening the hashing cost parameters.
jest.setTimeout(20000);

describe('PasswordService', () => {
  const service = new PasswordService();

  it('hashes a password as argon2id, never storing the plaintext', async () => {
    const hash = await service.hash('correcthorsebattery');
    expect(hash).not.toBe('correcthorsebattery');
    expect(hash.startsWith('$argon2id$')).toBe(true);
  });

  it('verifies a correct password against its own hash', async () => {
    const hash = await service.hash('correcthorsebattery');
    await expect(service.verify(hash, 'correcthorsebattery')).resolves.toBe(true);
  });

  it('rejects an incorrect password against a real hash', async () => {
    const hash = await service.hash('correcthorsebattery');
    await expect(service.verify(hash, 'wrong-password')).resolves.toBe(false);
  });

  it('always rejects when there is no stored hash (e.g. guest/passwordless account)', async () => {
    await expect(service.verify(null, 'anything-at-all')).resolves.toBe(false);
  });

  it('produces different hashes for the same password (random salt per hash)', async () => {
    const [a, b] = await Promise.all([
      service.hash('correcthorsebattery'),
      service.hash('correcthorsebattery'),
    ]);
    expect(a).not.toBe(b);
  });
});
