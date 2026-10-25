import { describe, expect, it } from 'vitest';
import { isEmbeddedWindow } from './use-embedded';

describe('isEmbeddedWindow', () => {
  it('is false for a top-level window (CRM opened on its own)', () => {
    const w = {} as Window & { self: unknown; top: unknown };
    w.self = w;
    w.top = w;
    expect(isEmbeddedWindow(w as Window)).toBe(false);
  });

  it('is true inside an iframe (the ERP embeds the CRM)', () => {
    const parent = {};
    const w = { top: parent } as unknown as Window & { self: unknown };
    w.self = w;
    expect(isEmbeddedWindow(w as Window)).toBe(true);
  });

  it('counts as embedded when the browser refuses to say', () => {
    const w = {} as Window;
    Object.defineProperty(w, 'self', { get: () => w });
    Object.defineProperty(w, 'top', { get: () => { throw new Error('SecurityError'); } });
    expect(isEmbeddedWindow(w)).toBe(true);
  });

  it('is false with no window (server rendering)', () => {
    expect(isEmbeddedWindow(undefined)).toBe(typeof window !== 'undefined' && window.self !== window.top);
  });
});
