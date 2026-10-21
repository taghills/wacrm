import { describe, it, expect } from 'vitest';

import { countAwaitingReply, parseInboxCountsBody, readInboxCounts } from './inbox-counts';
import { matchStoreByBranch } from './process';

describe('countAwaitingReply', () => {
  it('leaves out threads that end in "ok" / "thanks" / 👍', () => {
    expect(
      countAwaitingReply([
        { conversation_id: 'a', content_type: 'text', content_text: 'is my order ready?' },
        { conversation_id: 'b', content_type: 'text', content_text: 'OK MAM' },
        { conversation_id: 'c', content_type: 'text', content_text: '🙏' },
        { conversation_id: 'd', content_type: 'image', content_text: null },
      ]),
    ).toBe(2);
  });

  it('counts nothing for a missing or malformed result', () => {
    expect(countAwaitingReply(null)).toBe(0);
    expect(countAwaitingReply({})).toBe(0);
  });
});

describe('parseInboxCountsBody', () => {
  it('reads a branch', () => {
    expect(parseInboxCountsBody({ branch: 'Shastri Nagar' })).toEqual({
      branch: 'Shastri Nagar',
    });
  });

  it('treats a missing body, {} and an explicit null as the whole account', () => {
    // The ERP sends all three for the owner's overview.
    expect(parseInboxCountsBody(null)).toEqual({ branch: null });
    expect(parseInboxCountsBody(undefined)).toEqual({ branch: null });
    expect(parseInboxCountsBody({})).toEqual({ branch: null });
    expect(parseInboxCountsBody({ branch: null })).toEqual({ branch: null });
  });

  it('treats a blank branch as the whole account rather than a lookup', () => {
    // '   ' would otherwise be sent to the store matcher and come
    // back as "no store matches", which is a confusing 400 for what
    // is plainly an empty field.
    expect(parseInboxCountsBody({ branch: '   ' })).toEqual({ branch: null });
  });

  it('rejects a body that is not an object, or a branch that is not a string', () => {
    // Rejected rather than defaulted: a till asking for one branch
    // and being handed the company total is a wrong number nobody
    // would think to question.
    expect(parseInboxCountsBody({ branch: 42 })).toBeNull();
    expect(parseInboxCountsBody({ branch: ['a'] })).toBeNull();
    expect(parseInboxCountsBody([])).toBeNull();
    expect(parseInboxCountsBody('Shastri Nagar')).toBeNull();
  });
});

describe('readInboxCounts', () => {
  it('reads the single row the function returns', () => {
    expect(readInboxCounts([{ unread: 3, awaiting_reply: 5 }])).toEqual({
      unread: 3,
      awaitingReply: 5,
    });
  });

  it('accepts a bare object as well as a one-row array', () => {
    expect(readInboxCounts({ unread: 1, awaiting_reply: 2 })).toEqual({
      unread: 1,
      awaitingReply: 2,
    });
  });

  it('coerces a bigint that arrives as a string', () => {
    // Postgres COUNT is BIGINT, and a bigint can reach us as "12"
    // rather than 12. Unconverted, the ERP would render "12" where
    // it expects a number and arithmetic on it would concatenate.
    expect(readInboxCounts([{ unread: '12', awaiting_reply: '0' }])).toEqual({
      unread: 12,
      awaitingReply: 0,
    });
  });

  it('is zero, never NaN, for anything unexpected', () => {
    expect(readInboxCounts([])).toEqual({ unread: 0, awaitingReply: 0 });
    expect(readInboxCounts(null)).toEqual({ unread: 0, awaitingReply: 0 });
    expect(readInboxCounts([{ unread: 'nope' }])).toEqual({
      unread: 0,
      awaitingReply: 0,
    });
  });
});

describe('matchStoreByBranch', () => {
  const stores = [
    { id: 's1', name: 'Shastri Nagar', code: 'SHNR' },
    { id: 's2', name: 'Bardoli', code: 'BRD' },
  ];

  it('matches however the ERP spells the branch', () => {
    expect(matchStoreByBranch(stores, 'Shastri Nagar')?.id).toBe('s1');
    expect(matchStoreByBranch(stores, 'shastri-nagar')?.id).toBe('s1');
    expect(matchStoreByBranch(stores, 'SHASTRINAGAR')?.id).toBe('s1');
  });

  it('matches on the short code too', () => {
    expect(matchStoreByBranch(stores, 'shnr')?.id).toBe('s1');
  });

  it('returns null for a branch we do not have', () => {
    expect(matchStoreByBranch(stores, 'Bardoli Store')).toBeNull();
    expect(matchStoreByBranch([], 'Bardoli')).toBeNull();
  });

  it('matches nothing on an empty or punctuation-only branch', () => {
    // Otherwise '-' normalises to '' and would match a store whose
    // code normalises to '' — filing a customer under the wrong shop.
    expect(matchStoreByBranch(stores, '   ')).toBeNull();
    expect(matchStoreByBranch([{ id: 'x', name: 'x', code: '-' }], '-')).toBeNull();
  });
});
