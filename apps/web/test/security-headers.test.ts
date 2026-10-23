import { describe, expect, it } from 'vitest';
import {
  apiOriginOf,
  contentSecurityPolicy,
  productionApiUrlIssues,
  securityHeaders,
} from '../config/security-headers';

describe('web security headers', () => {
  const api = 'https://api.wayora.example';

  it('allows scripts only from the site itself and data only to the API', () => {
    const csp = contentSecurityPolicy({ apiOrigin: api });
    expect(csp).toContain("script-src 'self';");
    expect(csp).not.toMatch(/script-src[^;]*(unsafe-inline|unsafe-eval|\*)/);
    expect(csp).toContain(`connect-src 'self' ${api};`);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toMatch(/upgrade-insecure-requests$/);
  });

  it('omits frame-ancestors from the <meta> version, and upgrades only on https', () => {
    const meta = contentSecurityPolicy({ apiOrigin: 'http://localhost:4000', forMetaTag: true });
    expect(meta).not.toContain('frame-ancestors');
    expect(meta).not.toContain('upgrade-insecure-requests');
  });

  it('sends the hardening headers, but leaves HSTS to the TLS proxy', () => {
    const headers = securityHeaders({ apiOrigin: api });
    expect(headers).toMatchObject({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'DENY',
    });
    expect(headers['Strict-Transport-Security']).toBeUndefined();
  });

  it('production builds need an explicit, safe API URL', () => {
    expect(productionApiUrlIssues(undefined)[0]).toMatch(/not set/);
    expect(productionApiUrlIssues('http://api.wayora.example')[0]).toMatch(/https/);
    expect(productionApiUrlIssues('https://u:p@api.wayora.example')[0]).toMatch(/credentials/);
    expect(productionApiUrlIssues('not a url')[0]).toMatch(/valid URL/);
    expect(productionApiUrlIssues(api)).toEqual([]);
    expect(productionApiUrlIssues('http://localhost:4000')).toEqual([]);
    expect(apiOriginOf('https://api.wayora.example/')).toBe(api);
  });
});
