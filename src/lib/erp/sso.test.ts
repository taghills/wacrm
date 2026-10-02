import { describe, it, expect } from 'vitest';

import { hmacBase64Url } from './signature';
import {
  DEFAULT_NEXT,
  isAllowedErpRole,
  resolveSsoEmail,
  sanitizeNext,
  verifyErpSsoToken,
} from './sso';

const SECRET = 'c'.repeat(64);
const NOW = new Date('2026-10-02T10:00:00Z');
const soon = Math.floor(NOW.getTime() / 1000) + 60;

function mint(
  payload: Record<string, unknown>,
  secret = SECRET,
): string {
  const part = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${part}.${hmacBase64Url(part, secret)}`;
}

const validPayload = {
  sub: 'erp-user-1',
  email: 'Praveen@TAGHills.com',
  name: 'Praveen',
  username: 'praveen',
  role: 'admin',
  iat: soon - 60,
  exp: soon,
  nonce: 'n1',
  next: '/dashboard/inbox?phone=919999999999',
};

describe('sanitizeNext', () => {
  it('keeps a site-relative path', () => {
    expect(sanitizeNext('/inbox?c=abc')).toBe('/inbox?c=abc');
  });

  it('refuses an absolute URL', () => {
    expect(sanitizeNext('https://evil.example/steal')).toBe(DEFAULT_NEXT);
  });

  it('refuses a protocol-relative URL', () => {
    // `//evil.example` is a *different site*, not a path on ours.
    expect(sanitizeNext('//evil.example/steal')).toBe(DEFAULT_NEXT);
  });

  it('refuses a backslash-escaped protocol-relative URL', () => {
    expect(sanitizeNext('/\\evil.example')).toBe(DEFAULT_NEXT);
  });

  it('falls back for empty or non-string input', () => {
    expect(sanitizeNext('')).toBe(DEFAULT_NEXT);
    expect(sanitizeNext(undefined)).toBe(DEFAULT_NEXT);
    expect(sanitizeNext(42)).toBe(DEFAULT_NEXT);
  });
});

describe('isAllowedErpRole', () => {
  it('accepts the four ERP roles, in any casing', () => {
    for (const role of ['admin', 'Owner', 'CompanyAdmin', 'MANAGER']) {
      expect(isAllowedErpRole(role)).toBe(true);
    }
  });

  it('refuses anything else', () => {
    for (const role of ['cashier', 'optometrist', 'viewer', '', null, 7]) {
      expect(isAllowedErpRole(role)).toBe(false);
    }
  });
});

describe('resolveSsoEmail', () => {
  it('lowercases a real email', () => {
    expect(resolveSsoEmail({ email: 'A@B.com' })).toBe('a@b.com');
  });

  it('synthesises from username when there is no email', () => {
    expect(resolveSsoEmail({ username: 'Mahipal' })).toBe('mahipal@erp.local');
  });

  it('returns null when neither is usable', () => {
    expect(resolveSsoEmail({})).toBeNull();
    expect(resolveSsoEmail({ email: 'not-an-email' })).toBeNull();
  });
});

describe('verifyErpSsoToken', () => {
  it('accepts a valid token and sanitises next', () => {
    const result = verifyErpSsoToken(mint(validPayload), SECRET, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.email).toBe('praveen@taghills.com');
    expect(result.next).toBe('/dashboard/inbox?phone=919999999999');
  });

  it('rejects a token signed with a different secret', () => {
    const result = verifyErpSsoToken(
      mint(validPayload, 'd'.repeat(64)),
      SECRET,
      NOW,
    );
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a payload edited after signing', () => {
    // Swap the payload for a privilege-escalating one but keep the
    // original signature — the exact forgery the HMAC exists to stop.
    const [, sig] = mint({ ...validPayload, role: 'cashier' }, SECRET).split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...validPayload, role: 'owner' }),
    ).toString('base64url');
    const result = verifyErpSsoToken(`${forged}.${sig}`, SECRET, NOW);
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects an expired token', () => {
    const result = verifyErpSsoToken(mint(validPayload), SECRET, new Date(
      NOW.getTime() + 61_000,
    ));
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a token with no exp at all', () => {
    const { exp: _exp, ...noExp } = validPayload;
    const result = verifyErpSsoToken(mint(noExp), SECRET, NOW);
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a role the CRM does not accept', () => {
    const result = verifyErpSsoToken(
      mint({ ...validPayload, role: 'cashier' }),
      SECRET,
      NOW,
    );
    expect(result).toEqual({ ok: false, reason: 'role_not_allowed' });
  });

  it('rejects a token with no usable identity', () => {
    const result = verifyErpSsoToken(
      mint({ ...validPayload, email: null, username: null }),
      SECRET,
      NOW,
    );
    expect(result).toEqual({ ok: false, reason: 'no_identity' });
  });

  it('rejects malformed tokens without throwing', () => {
    for (const token of ['', 'nodot', 'a.b.c', null, undefined]) {
      expect(() => verifyErpSsoToken(token, SECRET, NOW)).not.toThrow();
      expect(verifyErpSsoToken(token, SECRET, NOW).ok).toBe(false);
    }
  });

  it('rejects a correctly signed token whose payload is not JSON', () => {
    const part = Buffer.from('not json at all').toString('base64url');
    const result = verifyErpSsoToken(
      `${part}.${hmacBase64Url(part, SECRET)}`,
      SECRET,
      NOW,
    );
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('fails closed when no secret is configured', () => {
    expect(verifyErpSsoToken(mint(validPayload), undefined, NOW).ok).toBe(false);
  });
});
