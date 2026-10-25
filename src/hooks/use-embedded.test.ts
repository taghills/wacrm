import { describe, expect, it } from 'vitest';
import { isEmbeddedWindow } from './use-embedded';

/** A stand-in window: only `self` and `top` matter to isEmbeddedWindow. */
function fakeWindow(top: 'self' | 'other' | 'throws'): Window {
  const w: Record<string, unknown> = {};
  Object.defineProperty(w, 'self', { get: () => w });
  Object.defineProperty(w, 'top', {
    get: () => {
      if (top === 'throws') throw new Error('SecurityError');
      return top === 'self' ? w : {};
    },
  });
  return w as unknown as Window;
}

describe('isEmbeddedWindow', () => {
  it('is false for a top-level window (CRM opened on its own)', () => {
    expect(isEmbeddedWindow(fakeWindow('self'))).toBe(false);
  });

  it('is true inside an iframe (the ERP embeds the CRM)', () => {
    expect(isEmbeddedWindow(fakeWindow('other'))).toBe(true);
  });

  it('counts as embedded when the browser refuses to say', () => {
    expect(isEmbeddedWindow(fakeWindow('throws'))).toBe(true);
  });
});
