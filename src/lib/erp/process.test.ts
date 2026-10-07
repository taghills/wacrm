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
  buildSendParams,
  downgradeToApprovedTemplate,
  normalizeStoreKey,
  sendFailureDetail,
  storeLinkNote,
  UNMATCHED_BRANCH,
  withNote,
} from './process';

describe('storeLinkNote', () => {
  it('names the store a contact was filed to', () => {
    expect(
      storeLinkNote({
        linked: true,
        storeId: '11111111-2222-3333-4444-555555555555',
        storeName: 'Demo',
        storeCode: 'DEMO',
        storePhone: '+91 76786 88524',
        storeReviewUrl: null,
      }),
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

describe('sendFailureDetail', () => {
  // Written after a live test came back as
  //   "Meta API error: (#132001) Template name does not exist in the
  //    translation"
  // which is the same string for every template and says nothing
  // about the document header — so the one question the test existed
  // to answer could not be answered from the ledger.
  const META_ERROR = new Error(
    'Meta API error: (#132001) Template name does not exist in the translation',
  );

  it('names the template and its attachment', () => {
    expect(
      sendFailureDetail(
        {
          templateName: 'order_confirmation_doc',
          params: [],
          documentUrl: 'https://erp.example/d/8f2c91',
          documentFilename: 'Receipt-TH-0001.pdf',
        },
        META_ERROR,
      ),
    ).toBe(
      'sending order_confirmation_doc with Receipt-TH-0001.pdf failed: ' +
        'Meta API error: (#132001) Template name does not exist in the translation',
    );
  });

  it('distinguishes the plain template from the attachment one', () => {
    // The whole point: these two must not read alike, because which
    // one was attempted is how you tell whether the ERP sent a PDF
    // link at all.
    const plain = sendFailureDetail(
      { templateName: 'order_confirmation', params: [] },
      META_ERROR,
    );
    expect(plain).toContain('sending order_confirmation failed');
    expect(plain).not.toContain('with');
  });

  it('still says something useful when there is no filename', () => {
    expect(
      sendFailureDetail(
        {
          templateName: 'order_delivered_invoice',
          params: [],
          documentUrl: 'https://erp.example/d/abc',
        },
        META_ERROR,
      ),
    ).toContain('with an attachment');
  });

  it('handles a thrown non-Error', () => {
    expect(
      sendFailureDetail({ templateName: 'order_ready', params: [] }, 'socket hang up'),
    ).toBe('sending order_ready failed: socket hang up');
  });
});

describe('buildSendParams', () => {
  const STORE_ID = '11111111-2222-3333-4444-555555555555';

  it('puts the store id on the review button, not the link', () => {
    // Meta allows one variable on a URL button and only as a suffix
    // on a fixed base. Four branches have four unrelated Google
    // links, so the link itself cannot go here — the button points
    // at /r/{{1}} and this is the {{1}}.
    expect(
      buildSendParams({ templateName: 'review_request', params: [] }, STORE_ID),
    ).toEqual({ buttonParams: { 0: STORE_ID } });
  });

  it('leaves the button alone when there is no store', () => {
    expect(
      buildSendParams({ templateName: 'review_request', params: [] }, null),
    ).toBeUndefined();
    expect(
      buildSendParams({ templateName: 'review_request', params: [] }, '  '),
    ).toBeUndefined();
  });

  it('carries a document header and its filename', () => {
    expect(
      buildSendParams(
        {
          templateName: 'order_confirmation_doc',
          params: [],
          documentUrl: 'https://erp.example/d/abc',
          documentFilename: 'Receipt-TH-0001.pdf',
        },
        null,
      ),
    ).toEqual({
      headerMediaUrl: 'https://erp.example/d/abc',
      headerFilename: 'Receipt-TH-0001.pdf',
    });
  });

  it('is undefined for a plain template, keeping the simpler send path', () => {
    expect(
      buildSendParams({ templateName: 'order_ready', params: [] }, STORE_ID),
    ).toBeUndefined();
  });
});

describe('downgradeToApprovedTemplate', () => {
  // The assurance that turned out to be wrong: "until the _doc
  // templates exist, the plain versions send instead". They did not.
  // Once the ERP put a receipt link on every order, every order chose
  // the _doc template, which Meta had never approved, and failed with
  // (#132001). The plain version was never reached.
  const PLAN = {
    templateName: 'order_confirmation_doc',
    params: ['Asha', 'demo'],
    documentUrl: 'https://erp.example/d/abc',
    documentFilename: 'Receipt-TH-0001.pdf',
  };

  function ctxWith(rows: Array<{ status: string }>) {
    return {
      db: {
        from: () => ({
          select: () => ({
            eq: () => ({ eq: async () => ({ data: rows }) }),
          }),
        }),
      },
      accountId: 'acc-1',
      currency: 'INR',
      reviewUrl: null,
      reviewDelayDays: 3,
      allowedBranches: [],
    } as unknown as Parameters<typeof downgradeToApprovedTemplate>[0];
  }

  it('drops to the plain template when the variant is not approved', async () => {
    const out = await downgradeToApprovedTemplate(ctxWith([{ status: 'PENDING' }]), PLAN);
    expect(out.templateName).toBe('order_confirmation');
    expect(out.documentUrl).toBeUndefined();
    expect(out.params).toEqual(PLAN.params);
  });

  it('drops to the plain template when the variant does not exist', async () => {
    const out = await downgradeToApprovedTemplate(ctxWith([]), PLAN);
    expect(out.templateName).toBe('order_confirmation');
  });

  it('keeps the attachment when the variant is approved', async () => {
    const out = await downgradeToApprovedTemplate(ctxWith([{ status: 'APPROVED' }]), PLAN);
    expect(out.templateName).toBe('order_confirmation_doc');
    expect(out.documentUrl).toBe('https://erp.example/d/abc');
  });

  it('tolerates a lowercase status', async () => {
    const out = await downgradeToApprovedTemplate(ctxWith([{ status: 'approved' }]), PLAN);
    expect(out.templateName).toBe('order_confirmation_doc');
  });

  it('leaves a plan with no attachment alone, without a database trip', async () => {
    const plain = { templateName: 'order_ready', params: ['Asha'] };
    const ctx = { accountId: 'acc-1' } as never; // no db — would throw if used
    expect(await downgradeToApprovedTemplate(ctx, plain)).toBe(plain);
  });
});
