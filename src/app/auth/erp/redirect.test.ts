import { describe, it, expect } from 'vitest';

import { ssoRedirect } from './redirect';

describe('ssoRedirect', () => {
  it('sends a relative Location, never an absolute URL', () => {
    // The regression: NextResponse.redirect(new URL(next, request.url))
    // resolved against the address the Node process is bound to. Behind
    // Hostinger's proxy that is http://0.0.0.0:3000, so a successful
    // sign-in redirected the browser to https://0.0.0.0:3000/dashboard
    // and looked like the whole site was down.
    const location = ssoRedirect('/dashboard').headers.get('location');
    expect(location).toBe('/dashboard');
    expect(location).not.toMatch(/^https?:\/\//);
    expect(location).not.toContain('0.0.0.0');
  });

  it('keeps the query string of a deep link', () => {
    expect(
      ssoRedirect('/dashboard/inbox?phone=919999999999').headers.get('location'),
    ).toBe('/dashboard/inbox?phone=919999999999');
  });

  it('is a 302 and is never cached', () => {
    // A cached redirect would send the next person to the previous
    // person's deep link.
    const response = ssoRedirect('/dashboard');
    expect(response.status).toBe(302);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
