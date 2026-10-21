/**
 * Country names for the nationality picker, from the browser's own locale
 * data (Intl.DisplayNames), so no country list is bundled. Codes are ISO
 * 3166-1 alpha-2, as stored by the API.
 */

// Region codes Intl knows that aren't countries a passport is issued by.
const NOT_COUNTRIES = new Set(['EU', 'EZ', 'UN', 'ZZ', 'AQ']);
const isUserAssigned = (code: string) =>
  code.startsWith('Q') || (code.startsWith('X') && code !== 'XK') || code === 'AA' || code === 'ZZ';

export interface CountryOption {
  code: string;
  name: string;
}

let cache: { locale: string; options: CountryOption[] } | null = null;

function displayNames(locale: string): Intl.DisplayNames | null {
  try {
    return new Intl.DisplayNames([locale, 'en'], { type: 'region', fallback: 'none' });
  } catch {
    return null;
  }
}

export function countryOptions(locale = 'en'): CountryOption[] {
  if (cache?.locale === locale) return cache.options;
  const names = displayNames(locale);
  const options: CountryOption[] = [];
  if (names) {
    for (let a = 65; a <= 90; a += 1) {
      for (let b = 65; b <= 90; b += 1) {
        const code = String.fromCharCode(a, b);
        if (NOT_COUNTRIES.has(code) || isUserAssigned(code)) continue;
        const name = names.of(code);
        if (name && name !== code) options.push({ code, name });
      }
    }
  }
  options.sort((x, y) => x.name.localeCompare(y.name, locale));
  cache = { locale, options };
  return options;
}

/** "India" for "IN"; the code itself if the browser has no name for it. */
export function countryName(code: string, locale = 'en'): string {
  return displayNames(locale)?.of(code) ?? code;
}
