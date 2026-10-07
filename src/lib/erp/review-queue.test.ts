// ============================================================
// The review queue's one rule worth a test without a database:
// what makes an order unique.
//
// If two different orders share a key they collide on one queue row
// and one customer never gets asked. If one order produces two keys
// the same customer gets asked twice. Both are silent.
// ============================================================

import { describe, expect, it } from 'vitest';

import { resolveReviewUrl, reviewOrderKey } from './review-queue';

describe('reviewOrderKey', () => {
  it('prefers the bill number', () => {
    expect(reviewOrderKey({ billNo: 'TH-0001', erpOrderId: 'o-1' })).toBe('TH-0001');
  });

  it('falls back to the order id when there is no bill yet', () => {
    // An order can be delivered before it is billed. Keying on an
    // empty string would collapse every such order in the account
    // onto one queue row.
    expect(reviewOrderKey({ erpOrderId: 'o-1' })).toBe('o-1');
    expect(reviewOrderKey({ billNo: '', erpOrderId: 'o-1' })).toBe('o-1');
    expect(reviewOrderKey({ billNo: '   ', erpOrderId: 'o-1' })).toBe('o-1');
  });

  it('returns null when the order has no identifier at all', () => {
    // The caller queues nothing in this case, rather than inventing
    // a key that would collide with the next such order.
    expect(reviewOrderKey({})).toBeNull();
    expect(reviewOrderKey({ billNo: '', erpOrderId: '' })).toBeNull();
    expect(reviewOrderKey({ billNo: 42, erpOrderId: null })).toBeNull();
  });

  it('trims surrounding space so one order yields one key', () => {
    expect(reviewOrderKey({ billNo: ' TH-0001 ' })).toBe('TH-0001');
  });
});

describe('resolveReviewUrl', () => {
  const ACCOUNT = 'https://g.page/r/account';
  const STORE = 'https://g.page/r/bahadurgarh';

  it('sends the customer to the branch that served them', () => {
    // The whole point: a Bahadurgarh customer's review belongs on
    // Bahadurgarh's listing, not on the account-wide one.
    expect(resolveReviewUrl(STORE, ACCOUNT)).toBe(STORE);
  });

  it('falls back to the account link while a branch has none', () => {
    // This is what makes a staged rollout work — the links can be
    // collected one branch at a time.
    expect(resolveReviewUrl(null, ACCOUNT)).toBe(ACCOUNT);
    expect(resolveReviewUrl('', ACCOUNT)).toBe(ACCOUNT);
    expect(resolveReviewUrl('   ', ACCOUNT)).toBe(ACCOUNT);
  });

  it('uses the store link even when the account has none', () => {
    // The ordering bug this guards: checking the account-wide link
    // first would skip a branch that has its own listing while the
    // account field sits empty.
    expect(resolveReviewUrl(STORE, null)).toBe(STORE);
    expect(resolveReviewUrl(STORE, '')).toBe(STORE);
  });

  it('is null when neither exists, so the caller can skip', () => {
    expect(resolveReviewUrl(null, null)).toBeNull();
    expect(resolveReviewUrl('', '  ')).toBeNull();
    expect(resolveReviewUrl(undefined, undefined)).toBeNull();
  });

  it('trims, so a stray space is not mistaken for a link', () => {
    expect(resolveReviewUrl(`  ${STORE}  `, ACCOUNT)).toBe(STORE);
  });
});
