// ============================================================
// The filing note that ends up in the event ledger.
//
// These exist because the bug they guard against is invisible: a
// branch name the CRM has no store for still creates the contact and
// still sends the message, so nothing fails. The only evidence is the
// text recorded here, and `/api/erp/status` finds it by searching for
// UNMATCHED_BRANCH verbatim — which makes that string a wire format
// between the two files, not a log message to reword freely.
// ============================================================

import { describe, expect, it } from 'vitest';

import {
  normalizeStoreKey,
  storeLinkNote,
  UNMATCHED_BRANCH,
  withNote,
} from './process';

describe('storeLinkNote', () => {
  it('names the store a contact was filed to', () => {
    expect(
      storeLinkNote({ linked: true, storeName: 'Demo', storeCode: 'DEMO' }),
    ).toBe('filed to Demo');
  });

  it('says nothing when the event named no branch', () => {
    // Most non-order events carry no branch. Annotating every one of
    // them would bury the rows that actually need attention.
    expect(storeLinkNote(null)).toBeNull();
  });

  it('passes an unmatched reason through untouched', () => {
    const reason = `${UNMATCHED_BRANCH}Demo Store`;
    expect(storeLinkNote({ linked: false, reason })).toBe(reason);
  });
});

describe('withNote', () => {
  it('joins the outcome and the note', () => {
    expect(withNote('sent order_confirmation', 'filed to Demo')).toBe(
      'sent order_confirmation | filed to Demo',
    );
  });

  it('leaves the detail alone when there is no note', () => {
    expect(withNote('contact synced', null)).toBe('contact synced');
  });

  it('records the note alone when the gate gave no reason', () => {
    // shouldSendForBranch returns no reason when it lets an event
    // through, but the filing outcome is still worth keeping.
    expect(withNote(undefined, 'filed to Demo')).toBe('filed to Demo');
  });

  it('stays undefined when there is neither', () => {
    expect(withNote(undefined, null)).toBeUndefined();
  });
});

describe('UNMATCHED_BRANCH', () => {
  it('lets the status route recover the branch name verbatim', () => {
    // This is the exact parse /api/erp/status performs. If the marker
    // or the join format changes, this breaks rather than the page
    // silently reporting no problems.
    const detail = withNote(
      'sent order_confirmation',
      `${UNMATCHED_BRANCH}Demo Store`,
    );
    const at = detail!.indexOf(UNMATCHED_BRANCH);
    expect(at).toBeGreaterThan(-1);
    expect(detail!.slice(at + UNMATCHED_BRANCH.length)).toBe('Demo Store');
  });

  it('recovers the branch name when no stores exist at all', () => {
    const detail = withNote(
      'contact synced',
      `${UNMATCHED_BRANCH}Demo (no active stores)`,
    );
    const at = detail!.indexOf(UNMATCHED_BRANCH);
    const branch = detail!
      .slice(at + UNMATCHED_BRANCH.length)
      .replace(/ \(no active stores\)$/, '')
      .trim();
    expect(branch).toBe('Demo');
  });
});

describe('normalizeStoreKey', () => {
  it('matches a store named Demo to the ERP branch "demo"', () => {
    // The whole basis of the link: the two systems were named by
    // different people, so case, spaces and punctuation must not
    // decide whether a customer gets filed.
    expect(normalizeStoreKey('Demo')).toBe(normalizeStoreKey('demo'));
    expect(normalizeStoreKey('Shastri Nagar')).toBe(
      normalizeStoreKey('shastri-nagar'),
    );
    expect(normalizeStoreKey('Rohini Sec-7')).toBe(
      normalizeStoreKey('ROHINI SEC 7'),
    );
  });

  it('does not collapse two different branches together', () => {
    expect(normalizeStoreKey('Rohini Sec 7')).not.toBe(
      normalizeStoreKey('Rohini Sec 9'),
    );
  });
});
