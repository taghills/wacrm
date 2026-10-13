// ============================================================
// What a row MEANS.
//
// The screen exists because the answer was split between two
// systems. These pin the places where collapsing them could lie:
// a contact sync must not read as a sent message, a failure must
// not read as "didn't arrive", and Meta's verdict must win over our
// own record of having handed the message over.
// ============================================================

import { describe, expect, it } from 'vitest';

import {
  ACTIVITY_OUTCOMES,
  countByOutcome,
  entryFor,
  isActivityOutcome,
  isMessageEvent,
  outcomeFor,
  reasonFor,
  type ActivityRow,
} from './activity';

function row(over: Partial<ActivityRow> = {}): ActivityRow {
  return {
    eventId: '2830',
    eventType: 'order.created',
    erpStatus: 'done',
    detail: 'sent order_confirmation_doc | filed to bardoli',
    branch: 'bardoli',
    orderRef: 'BARD-2627-SO-0012',
    receivedAt: '2026-10-12T14:57:04Z',
    contactName: 'Asha Verma',
    contactId: 'c-1',
    messageStatus: null,
    messageError: null,
    ...over,
  };
}

describe('outcomeFor', () => {
  it('lets Meta have the last word', () => {
    // We recorded `done` the moment we handed the message over.
    // Meta then said it failed. Reporting "sent" because our own
    // row says so is how a customer who got nothing is told they
    // were messaged.
    expect(outcomeFor(row({ messageStatus: 'failed' }))).toBe('failed');
    expect(outcomeFor(row({ messageStatus: 'delivered' }))).toBe('delivered');
    expect(outcomeFor(row({ messageStatus: 'read' }))).toBe('read');
  });

  it('calls a held-back event not sent, not failed', () => {
    // Two different actions: one is a setting someone can change,
    // the other is a number that may be wrong. Collapsing them is
    // how a fixable problem looks like bad luck.
    expect(
      outcomeFor(
        row({
          erpStatus: 'skipped',
          detail: 'held back: sending is limited to bardoli, this event is for Bahadurgarh',
          messageStatus: null,
        }),
      ),
    ).toBe('not_sent');
  });

  it('calls a send that threw failed', () => {
    expect(outcomeFor(row({ erpStatus: 'failed', detail: 'sending … failed: …' }))).toBe(
      'failed',
    );
  });

  it('does not call a done row sent when nothing was sent', () => {
    // `customer.upsert` succeeds having sent nothing. This is the
    // same trap the ERP's own report had to be fixed for.
    expect(
      outcomeFor(
        row({ eventType: 'customer.upsert', detail: 'contact synced', messageStatus: null }),
      ),
    ).toBe('not_sent');
  });

  it('reads a done row with no delivery news yet as sent', () => {
    // Meta's webhook lands a moment after the send. Until then the
    // ledger's own word is all there is.
    expect(outcomeFor(row({ messageStatus: null }))).toBe('sent');
  });

  it('only ever returns a known outcome', () => {
    for (const status of ['done', 'skipped', 'failed', 'weird']) {
      for (const m of [null, 'sent', 'delivered', 'read', 'failed', 'sending', 'odd']) {
        expect(ACTIVITY_OUTCOMES).toContain(outcomeFor(row({ erpStatus: status, messageStatus: m })));
      }
    }
  });
});

describe('reasonFor', () => {
  it('prefers Meta’s reason on a failure', () => {
    // "sent order_ready" is true and useless when the number is not
    // on WhatsApp.
    expect(
      reasonFor(
        row({
          detail: 'sent order_ready | filed to bardoli',
          messageStatus: 'failed',
          messageError: 'Message undeliverable — not a WhatsApp number',
        }),
      ),
    ).toBe('Message undeliverable — not a WhatsApp number');
  });

  it('falls back to the ledger’s words, which name the fix', () => {
    const detail = 'store Bahadurgarh has no contact number: set it in Settings -> Stores';
    expect(reasonFor(row({ erpStatus: 'skipped', detail }))).toBe(detail);
  });

  it('never returns an empty line', () => {
    expect(reasonFor(row({ detail: null, messageError: null }))).toBe(
      'no reason was recorded',
    );
    expect(reasonFor(row({ detail: '   ' }))).toBe('no reason was recorded');
  });
});

describe('countByOutcome', () => {
  it('counts every outcome, zeroes included', () => {
    // A missing key reads as "no data"; a zero reads as "nothing
    // wrong". Only one of those is what an empty count means.
    const counts = countByOutcome([entryFor(row({ messageStatus: 'failed' }))]);
    expect(counts).toEqual({ failed: 1, not_sent: 0, sent: 0, delivered: 0, read: 0 });
  });
});

describe('isMessageEvent', () => {
  it('leaves the silent event types out of the list', () => {
    expect(isMessageEvent('ping')).toBe(false);
    expect(isMessageEvent('customer.upsert')).toBe(false);
    expect(isMessageEvent('order.ready')).toBe(true);
    expect(isMessageEvent('order.sold')).toBe(true);
  });
});

describe('isActivityOutcome', () => {
  it('guards the query parameter', () => {
    expect(isActivityOutcome('failed')).toBe(true);
    expect(isActivityOutcome('exploded')).toBe(false);
    expect(isActivityOutcome(null)).toBe(false);
  });
});

describe('the bill number', () => {
  it('rides on the row so the search box has something to match', () => {
    // "Asha Verma, Bahadurgarh, not sent" is a worse answer than
    // "BDGR-2627-SO-0014, not sent" when four people called Asha
    // bought glasses this month.
    const entry = entryFor(row({ orderRef: 'BDGR-2627-SO-0014' }));
    expect(entry.orderRef).toBe('BDGR-2627-SO-0014');
  });

  it('is absent, not blank, for an event that has no order', () => {
    expect(entryFor(row({ orderRef: null })).orderRef).toBeNull();
  });
});
