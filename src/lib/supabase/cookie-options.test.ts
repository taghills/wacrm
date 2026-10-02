import { describe, it, expect } from 'vitest';

import {
  crossSiteCookiesEnabled,
  sessionCookieOptions,
} from './cookie-options';

describe('crossSiteCookiesEnabled', () => {
  it('is on in production', () => {
    expect(crossSiteCookiesEnabled('production')).toBe(true);
  });

  it('is off in development and test', () => {
    // Secure cookies are dropped over http://localhost, so turning
    // this on in dev would break local sign-in entirely.
    expect(crossSiteCookiesEnabled('development')).toBe(false);
    expect(crossSiteCookiesEnabled('test')).toBe(false);
    expect(crossSiteCookiesEnabled(undefined)).toBe(false);
  });
});

describe('sessionCookieOptions', () => {
  it('adds SameSite=None, Secure and Partitioned when enabled', () => {
    expect(sessionCookieOptions({ path: '/' }, true)).toEqual({
      path: '/',
      sameSite: 'none',
      secure: true,
      partitioned: true,
    });
  });

  it('overrides a Lax that Supabase set, rather than appending to it', () => {
    // The library passes its own sameSite; if ours did not win, the
    // cookie would still be dropped inside the ERP iframe.
    expect(sessionCookieOptions({ sameSite: 'lax' }, true).sameSite).toBe('none');
  });

  it('preserves unrelated options', () => {
    const result = sessionCookieOptions(
      { path: '/', httpOnly: true, maxAge: 3600 },
      true,
    );
    expect(result.path).toBe('/');
    expect(result.httpOnly).toBe(true);
    expect(result.maxAge).toBe(3600);
  });

  it('passes options through untouched when disabled', () => {
    const input = { path: '/', sameSite: 'lax' as const };
    expect(sessionCookieOptions(input, false)).toBe(input);
  });
});
