// ============================================================
// The review link and the delay.
//
// Both are operator-editable, which means both arrive as whatever
// someone typed. These tests pin the two rules that protect a send:
// a button URL Meta would refuse never becomes "configured", and a
// delay outside the database's CHECK range never reaches it.
// ============================================================

import { describe, expect, it } from 'vitest';

import {
  clampDelay,
  DEFAULT_REVIEW_DELAY_DAYS,
  MAX_REVIEW_DELAY_DAYS,
  normalizeUrl,
  reviewDueAt,
} from './message-settings';

describe('normalizeUrl', () => {
  it('keeps an https link, trimmed', () => {
    expect(normalizeUrl('  https://g.page/r/abc  ')).toBe('https://g.page/r/abc');
  });

  it('refuses anything that is not https', () => {
    // Meta rejects a non-https button URL, and a link the customer
    // cannot open is worse than no message at all.
    expect(normalizeUrl('http://g.page/r/abc')).toBeNull();
    expect(normalizeUrl('g.page/r/abc')).toBeNull();
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
  });

  it('treats blank and missing alike', () => {
    // "Unset" needs one representation, so the send path has one
    // thing to test for.
    expect(normalizeUrl('')).toBeNull();
    expect(normalizeUrl('   ')).toBeNull();
    expect(normalizeUrl(null)).toBeNull();
    expect(normalizeUrl(undefined)).toBeNull();
  });

  it('refuses https with nothing after it', () => {
    expect(normalizeUrl('https://')).toBeNull();
    expect(normalizeUrl('https:// spaced.example')).toBeNull();
  });
});

describe('clampDelay', () => {
  it('keeps a value inside the range', () => {
    expect(clampDelay(0)).toBe(0);
    expect(clampDelay(3)).toBe(3);
    expect(clampDelay(MAX_REVIEW_DELAY_DAYS)).toBe(MAX_REVIEW_DELAY_DAYS);
  });

  it('pulls an out-of-range value to the nearest edge', () => {
    // The database CHECK would reject these outright; clamping keeps
    // a typo from failing a save that is otherwise fine.
    expect(clampDelay(-5)).toBe(0);
    expect(clampDelay(300)).toBe(MAX_REVIEW_DELAY_DAYS);
  });

  it('falls back to the default for a value that is not a number', () => {
    expect(clampDelay(Number.NaN)).toBe(DEFAULT_REVIEW_DELAY_DAYS);
    expect(clampDelay(Number.POSITIVE_INFINITY)).toBe(DEFAULT_REVIEW_DELAY_DAYS);
  });

  it('truncates a fraction rather than rounding up', () => {
    // 3.9 days is 3 days: asking early is better than asking late.
    expect(clampDelay(3.9)).toBe(3);
  });
});

describe('reviewDueAt', () => {
  it('adds the delay in whole days', () => {
    const now = new Date('2026-10-07T11:30:00.000Z');
    expect(reviewDueAt(3, now).toISOString()).toBe('2026-10-10T11:30:00.000Z');
  });

  it('is due immediately at zero', () => {
    const now = new Date('2026-10-07T11:30:00.000Z');
    expect(reviewDueAt(0, now).toISOString()).toBe(now.toISOString());
  });

  it('crosses a month end correctly', () => {
    const now = new Date('2026-10-30T09:00:00.000Z');
    expect(reviewDueAt(3, now).toISOString()).toBe('2026-11-02T09:00:00.000Z');
  });

  it('does not mutate the date it was given', () => {
    const now = new Date('2026-10-07T11:30:00.000Z');
    reviewDueAt(3, now);
    expect(now.toISOString()).toBe('2026-10-07T11:30:00.000Z');
  });
});
