import { z } from 'zod';

/*
 * Authentication, profile and saved-traveller contracts (Phase 8).
 *
 * Shared by the API (request validation) and the web app (form validation),
 * so both sides apply exactly the same rules. Server-side validation is the
 * authority; client-side validation is for fast, friendly feedback.
 */

// ─── Primitives ───────────────────────────────────────────────────────────

/** Password length policy (NIST SP 800-63B style: length over composition rules). */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;
/** Upper bound on saved travellers per account (abuse guard, not a product limit). */
export const MAX_TRAVELLERS_PER_USER = 20;

/**
 * Normalizes email addresses the same way everywhere: trimmed and lower-cased.
 * (The database enforces both with CHECK constraints.)
 */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export const emailSchema = z
  .string({ error: 'Enter your email address.' })
  .trim()
  .min(1, 'Enter your email address.')
  .max(254, 'That email address is too long.')
  .toLowerCase()
  .pipe(z.email({ error: 'Enter a valid email address, like name@example.com.' }));

// Letters, marks, spaces and common name punctuation; no control characters.
const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M}' .,-]*$/u;

/** A person's name: trimmed, inner whitespace collapsed. */
const personName = (label: string, max: number) =>
  z
    .string({ error: `Enter ${label}.` })
    .transform((v) => v.trim().replace(/\s+/g, ' '))
    .pipe(
      z
        .string()
        .min(1, `Enter ${label}.`)
        .max(max, `Use ${max} characters or fewer.`)
        .regex(NAME_PATTERN, 'Use letters, spaces, hyphens or apostrophes.'),
    );

export const nameSchema = personName('your name', 120);

/** A small denylist of passwords that appear at the top of every breach corpus. */
const COMMON_PASSWORDS = new Set([
  '1234567890',
  '12345678910',
  '0123456789',
  'password12',
  'password123',
  'password1234',
  'qwertyuiop',
  'qwerty1234',
  'iloveyou12',
  'letmein123',
  'welcome123',
  'admin12345',
  'abcdefghij',
  'aaaaaaaaaa',
  'wayora1234',
  'passw0rd123',
]);

/** A new password (registration). Not trimmed: spaces are allowed and significant. */
export const newPasswordSchema = z
  .string({ error: 'Enter a password.' })
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(PASSWORD_MAX_LENGTH, `Use ${PASSWORD_MAX_LENGTH} characters or fewer.`)
  .refine((v) => v.trim().length >= PASSWORD_MIN_LENGTH, {
    error: `Use at least ${PASSWORD_MIN_LENGTH} characters that aren't spaces.`,
  })
  .refine((v) => !COMMON_PASSWORDS.has(v.toLowerCase()), {
    error: 'This password is too common. Choose something harder to guess.',
  });

// ─── Requests ─────────────────────────────────────────────────────────────

export const registerRequestSchema = z
  .object({
    name: nameSchema,
    email: emailSchema,
    password: newPasswordSchema,
  })
  .strict();
export type RegisterRequest = z.input<typeof registerRequestSchema>;

export const loginRequestSchema = z
  .object({
    email: emailSchema,
    // Login never applies the creation policy (older passwords stay valid);
    // it only bounds the input.
    password: z
      .string({ error: 'Enter your password.' })
      .min(1, 'Enter your password.')
      .max(PASSWORD_MAX_LENGTH, 'That password is too long.'),
  })
  .strict();
export type LoginRequest = z.input<typeof loginRequestSchema>;

/** Only these fields can be changed through PATCH /users/me. Unknown keys are rejected. */
export const updateProfileRequestSchema = z.object({ name: nameSchema }).strict();
export type UpdateProfileRequest = z.input<typeof updateProfileRequestSchema>;

// ─── Responses ────────────────────────────────────────────────────────────

/** The only user representation the API ever returns. No hashes, tokens or status internals. */
export const safeUserSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
  /** True only after a real verification flow (none exists yet, so always false today). */
  emailVerified: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type SafeUser = z.infer<typeof safeUserSchema>;

export const authResponseSchema = z.object({ user: safeUserSchema });
export type AuthResponse = z.infer<typeof authResponseSchema>;

/**
 * GET /auth/session: who this browser is signed in as. Always 200: `user` is
 * null when there is no valid session, so a signed-out visitor is a normal
 * answer, not an error.
 */
export const sessionResponseSchema = z.object({ user: safeUserSchema.nullable() });
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

// ─── Saved travellers ─────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD, a real calendar date, not in the future and not before 1900. */
export const dateOfBirthSchema = z
  .string()
  .regex(ISO_DATE, 'Use the format YYYY-MM-DD.')
  .refine(
    (v) => {
      const d = new Date(`${v}T00:00:00Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
    },
    { error: 'Enter a real date.' },
  )
  .refine((v) => v >= '1900-01-01', { error: 'Enter a date after 1900.' })
  .refine((v) => v <= new Date().toISOString().slice(0, 10), {
    error: "Date of birth can't be in the future.",
  });

/** ISO 3166-1 alpha-2 country code, upper-cased (e.g. IN). */
export const nationalitySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, 'Use a two-letter country code, like IN.');

const travellerFields = {
  firstName: personName('a first name', 100),
  lastName: personName('a last name', 100),
  /** Optional; only needed by some services (e.g. infant fares). `null` clears it. */
  dateOfBirth: dateOfBirthSchema.nullable().optional(),
  nationality: nationalitySchema.nullable().optional(),
};

export const createTravellerRequestSchema = z.object(travellerFields).strict();
export type CreateTravellerRequest = z.input<typeof createTravellerRequestSchema>;

export const updateTravellerRequestSchema = z
  .object(travellerFields)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { error: 'Change at least one field.' });
export type UpdateTravellerRequest = z.input<typeof updateTravellerRequestSchema>;

export const travellerParamsSchema = z.object({
  travellerId: z.uuid({ error: 'Not a valid traveller id.' }),
});

export const travellerSchema = z.object({
  id: z.uuid(),
  firstName: z.string(),
  lastName: z.string(),
  dateOfBirth: z.string().nullable(),
  nationality: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Traveller = z.infer<typeof travellerSchema>;

export const travellerListSchema = z.array(travellerSchema);
