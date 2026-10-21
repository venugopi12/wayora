import { createHash, randomBytes } from 'node:crypto';

/** 32 random bytes (256 bits), base64url: the value carried by the session cookie. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Only this hex SHA-256 is stored; the token itself never touches the database or logs. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Rejects obviously malformed cookie values before any database lookup. */
export function isWellFormedToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}
