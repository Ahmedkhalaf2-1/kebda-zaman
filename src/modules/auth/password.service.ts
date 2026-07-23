import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/**
 * Argon2id password hashing. Never stores or logs plaintext.
 *
 * `verify` always performs an argon2 verification even when no real hash
 * exists (unknown email / guest / admin-seeded-without-password), using a
 * fixed decoy hash so response timing does not reveal whether an account
 * exists (plan §5.1: "constant-time behavior for unknown email vs bad
 * password").
 */
@Injectable()
export class PasswordService {
  // Static argon2id hash of a decoy string — never a real account's password.
  // Used only to equalize verification timing when there is no real hash to check.
  private static readonly DECOY_HASH =
    '$argon2id$v=19$m=65536,p=4,t=3$/BgqBvOqdtUi5E7IEesU8g$H2pGEDJMc9MtOP6ie8hMGg+tTIBIDe5TF6IULENRKFA';

  async hash(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id });
  }

  async verify(storedHash: string | null, password: string): Promise<boolean> {
    const target = storedHash ?? PasswordService.DECOY_HASH;
    let matches: boolean;
    try {
      matches = await argon2.verify(target, password);
    } catch {
      matches = false;
    }
    return storedHash !== null && matches;
  }
}
