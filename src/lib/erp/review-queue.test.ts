// ============================================================
// The review queue's one rule worth a test without a database:
// what makes an order unique.
//
// If two different orders share a key they collide on one queue row
// and one customer never gets asked. If one order produces two keys
// the same customer gets asked twice. Both are silent.
// ============================================================

import { describe, expect, it } from 'vitest';

import { reviewOrderKey } from './review-queue';

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
