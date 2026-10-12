// ============================================================
// The ERP's view of an event.
//
// The bug this closes: a 200 meant "processed", the ERP read it as
// "sent", and a deliberately skipped event was indistinguishable
// from a delivered message. Staff saw "sent" against a bill nobody
// had been told about.
//
// So the two rules worth pinning: `sent` is only ever claimed when a
// message really went to Meta, and no outcome is ever reported
// without a reason.
// ============================================================

import { describe, expect, it } from 'vitest';

import {
  reportFor,
  reportForSettled,
  UNEXPLAINED,
  type ErpReportStatus,
} from './event-report';

describe('reportFor', () => {
  it('reports sent only when a message actually went out', () => {
    expect(
      reportFor('2700', {
        status: 'done',
        detail: 'sent order_confirmation_doc | filed to bardoli',
        whatsappMessageId: 'wamid.ABC',
      }),
    ).toEqual({
      eventId: '2700',
      status: 'sent',
      reason: 'sent order_confirmation_doc | filed to bardoli',
    });
  });

  it('does NOT call a contact sync sent', () => {
    // `customer.upsert` succeeds having sent nothing. Mapping our
    // `done` straight onto their `sent` would re-create, one layer
    // up, the exact confusion this whole change removes.
    expect(
      reportFor('2694', { status: 'done', detail: 'contact synced' }),
    ).toEqual({ eventId: '2694', status: 'skipped', reason: 'contact synced' });
  });

  it('passes a skip through with the reason staff need', () => {
    const reason =
      'held back: sending is limited to bardoli, this event is for Bahadurgarh | filed to Bahadurgarh';
    expect(reportFor('2698', { status: 'skipped', detail: reason })).toEqual({
      eventId: '2698',
      status: 'skipped',
      reason,
    });
  });

  it('passes a failure through with Meta’s reason', () => {
    const reason =
      'sending order_confirmation_doc with Receipt-TH-0001.pdf failed: (#131049) …';
    expect(reportFor('2699', { status: 'failed', detail: reason })).toEqual({
      eventId: '2699',
      status: 'failed',
      reason,
    });
  });

  it('never reports an outcome with no reason', () => {
    // "Every skip has a reason" is a promise to another team. A
    // promise kept by convention alone is one bad merge from broken.
    for (const status of ['skipped', 'failed', 'done'] as const) {
      expect(reportFor('x', { status }).reason).toBe(UNEXPLAINED);
      expect(reportFor('x', { status, detail: '   ' }).reason).toBe(UNEXPLAINED);
    }
  });

  it('only ever uses the three values the ERP reads', () => {
    const seen: ErpReportStatus[] = [
      reportFor('a', { status: 'done', whatsappMessageId: 'w' }).status,
      reportFor('b', { status: 'done' }).status,
      reportFor('c', { status: 'skipped' }).status,
      reportFor('d', { status: 'failed' }).status,
    ];
    expect(new Set(seen)).toEqual(new Set(['sent', 'skipped', 'failed']));
  });
});

describe('reportForSettled', () => {
  it('answers a replayed event from the ledger', () => {
    // Reporting nothing for an id the ERP asked about would leave it
    // exactly as blind as before the change.
    expect(
      reportForSettled('2698', 'skipped', 'held back: sending is limited to bardoli'),
    ).toEqual({
      eventId: '2698',
      status: 'skipped',
      reason: 'held back: sending is limited to bardoli',
    });
  });

  it('reads a stored done as sent', () => {
    // The documented limit: the ledger does not store the message id
    // yet, so a replayed `customer.upsert` reads as sent. Stage 2
    // adds that column. The reason text still says what happened.
    expect(reportForSettled('2629', 'done', 'sent order_confirmation_doc')).toEqual({
      eventId: '2629',
      status: 'sent',
      reason: 'sent order_confirmation_doc',
    });
  });

  it('still carries a reason when the ledger row has none', () => {
    expect(reportForSettled('2700', 'skipped', null).reason).toBe(UNEXPLAINED);
  });
});
