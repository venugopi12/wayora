import { hash, verify } from '@node-rs/argon2';

/** `Algorithm.Argon2id` (a const enum, which isolated modules can't import). */
const ARGON2ID = 2;

/**
 * Argon2id with the OWASP-recommended baseline (19 MiB memory, 2 iterations,
 * 1 lane). Hashes are self-describing PHC strings, so parameters can be raised
 * later: `needsRehash` flags old hashes and login re-hashes them.
 */
export const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

const PARAMS = `m=${ARGON2_OPTIONS.memoryCost},t=${ARGON2_OPTIONS.timeCost},p=${ARGON2_OPTIONS.parallelism}`;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

/** Never throws: a malformed or missing hash simply doesn't verify. */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

export function needsRehash(passwordHash: string): boolean {
  return !passwordHash.startsWith('$argon2id$') || !passwordHash.includes(`$${PARAMS}$`);
}

let dummyHash: Promise<string> | undefined;

/**
 * Verifies against a throwaway hash. Used when the account doesn't exist (or
 * has no password) so a failed login takes as long as a real one and response
 * timing doesn't reveal which emails are registered.
 */
export async function burnVerifyTime(password: string): Promise<void> {
  dummyHash ??= hash('wayora-dummy-password-for-timing', ARGON2_OPTIONS);
  await verifyPassword(await dummyHash, password);
}
