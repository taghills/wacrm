import { describe, it, expect } from 'vitest';

import { maskEmail } from './mask-email';

describe('maskEmail', () => {
  it('keeps the first two characters and the whole domain', () => {
    // Enough for someone to recognise their own address without the
    // endpoint handing out a readable roster of another account.
    expect(maskEmail('user3taghills@gmail.com')).toBe('us•••••••••••@gmail.com');
  });

  it('hides the length of nothing — the mask tracks the local part', () => {
    expect(maskEmail('ab@x.com')).toBe('ab•@x.com');
    expect(maskEmail('abc@x.com')).toBe('ab•@x.com');
  });

  it('does not leak a short local part verbatim', () => {
    expect(maskEmail('a@x.com')).toBe('a•@x.com');
  });

  it('handles a missing or malformed address without throwing', () => {
    expect(maskEmail(null)).toBe('(none)');
    expect(maskEmail(undefined)).toBe('(none)');
    expect(maskEmail('')).toBe('(none)');
    expect(maskEmail('not-an-email')).toBe('•••');
    expect(maskEmail('@nolocal.com')).toBe('•••');
  });
});
