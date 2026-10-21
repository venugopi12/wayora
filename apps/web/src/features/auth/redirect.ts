import { ACCOUNT_PATHS } from '../navigation/config';

/** Where people land after signing in when no (valid) destination was given. */
export const DEFAULT_AFTER_SIGN_IN = ACCOUNT_PATHS.profile;

/** Query parameter that carries the page someone was trying to open. */
export const REDIRECT_PARAM = 'redirect';

const AUTH_PAGES: readonly string[] = [ACCOUNT_PATHS.login, ACCOUNT_PATHS.register, '/sign-in'];
// A throwaway base: anything that resolves to another origin is rejected.
const BASE = 'https://wayora.invalid';

/**
 * Validates a post-sign-in destination so `?redirect=` can't send people to
 * another site (open redirect). Accepts only a same-site path such as
 * `/profile/travellers?x=1#y`; rejects absolute and protocol-relative URLs
 * (`https://…`, `//evil.example`, `/\\evil.example`), `javascript:`, control
 * characters, and the sign-in pages themselves (which would loop). Returns
 * the normalized path, or `fallback`.
 */
export function safeRedirectPath(
  value: string | null | undefined,
  fallback: string = DEFAULT_AFTER_SIGN_IN,
): string {
  if (!value || value.length > 2048) return fallback;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback;
  // C0 control characters and DEL: browsers strip or reinterpret them in URLs.
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return fallback;
  }
  let url: URL;
  try {
    url = new URL(value, BASE);
  } catch {
    return fallback;
  }
  if (url.origin !== BASE) return fallback;
  if (AUTH_PAGES.includes(url.pathname)) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** `/login?redirect=…` for the given current location (omits the parameter for the default). */
export function loginPathFor(currentPath: string, page: string = ACCOUNT_PATHS.login): string {
  const target = safeRedirectPath(currentPath, '');
  if (!target || target === '/') return page;
  return `${page}?${new URLSearchParams({ [REDIRECT_PARAM]: target }).toString()}`;
}
