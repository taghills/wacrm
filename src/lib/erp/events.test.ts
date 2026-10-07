import { describe, it, expect } from 'vitest';

import {
  extractBranch,
  extractCustomer,
  formatDate,
  formatMoney,
  isKnownEventType,
  isMarketingEvent,
  MAX_EVENTS_PER_BATCH,
  parseEventBatch,
  sanitizeParam,
  templatePlanFor,
  type ErpEvent,
} from './events';

const orderData = {
  erpOrderId: 'o-1',
  billNo: 'TH-0001',
  status: 'dispatched',
  branch: 'Shastri Nagar',
  customer: {
    erpCustomerId: 'c-1',
    name: 'Asha Verma',
    phone: '919999999999',
  },
  grandTotal: 4500,
  paid: 2000,
  balance: 2500,
  deliveryDate: '2026-10-05',
};

const event = (type: string, data: Record<string, unknown>): ErpEvent => ({
  id: '1042',
  type,
  data,
});

describe('parseEventBatch', () => {
  it('returns the events from a well-formed batch', () => {
    const events = parseEventBatch({
      source: 'taghills-erp',
      events: [{ id: '1', type: 'ping', data: {} }],
    });
    expect(events).toEqual([{ id: '1', type: 'ping', occurredAt: undefined, data: {} }]);
  });

  it('coerces a numeric id to a string so the ledger key is stable', () => {
    // The ledger's primary key is TEXT; 1042 and "1042" must be the
    // same event, or a re-delivery sends the message twice.
    const events = parseEventBatch({ events: [{ id: 1042, type: 'ping' }] });
    expect(events?.[0].id).toBe('1042');
  });

  it('defaults a missing data object rather than throwing', () => {
    const events = parseEventBatch({ events: [{ id: '1', type: 'ping' }] });
    expect(events?.[0].data).toEqual({});
  });

  it('drops events with no id or no type', () => {
    const events = parseEventBatch({
      events: [
        { id: '1', type: 'ping' },
        { type: 'ping' },
        { id: '2' },
        null,
        'nope',
      ],
    });
    expect(events?.map((e) => e.id)).toEqual(['1']);
  });

  it('caps the batch at the documented maximum', () => {
    const events = parseEventBatch({
      events: Array.from({ length: 150 }, (_, i) => ({ id: String(i), type: 'ping' })),
    });
    expect(events).toHaveLength(MAX_EVENTS_PER_BATCH);
  });

  it('returns null when the body is not a batch', () => {
    // null is the 400 signal — distinct from an empty batch, which
    // is a legitimate 200.
    expect(parseEventBatch(null)).toBeNull();
    expect(parseEventBatch([])).toBeNull();
    expect(parseEventBatch({ events: 'nope' })).toBeNull();
    expect(parseEventBatch({})).toBeNull();
  });
});

describe('isKnownEventType / isMarketingEvent', () => {
  it('knows the documented types', () => {
    expect(isKnownEventType('order.ready')).toBe(true);
    expect(isKnownEventType('order.cancelled')).toBe(false);
  });

  it('treats only birthday and recall as marketing', () => {
    expect(isMarketingEvent('customer.birthday')).toBe(true);
    expect(isMarketingEvent('customer.recall')).toBe(true);
    // Order and payment messages are service messages — an opt-out
    // must not stop someone hearing their glasses are ready.
    expect(isMarketingEvent('order.ready')).toBe(false);
    expect(isMarketingEvent('payment.received')).toBe(false);
  });
});

describe('extractCustomer', () => {
  it('reads the nested customer on order-shaped events', () => {
    expect(extractCustomer(event('order.ready', orderData))).toMatchObject({
      erpCustomerId: 'c-1',
      name: 'Asha Verma',
      phone: '919999999999',
    });
  });

  it('reads the top-level fields on customer-shaped events', () => {
    const customer = extractCustomer(
      event('customer.upsert', {
        erpCustomerId: 'c-2',
        name: 'Mahipal',
        phone: '919000000000',
        totalSpent: 12500,
        email: null,
      }),
    );
    expect(customer).toMatchObject({ erpCustomerId: 'c-2', totalSpent: 12500 });
    expect(customer?.email).toBeNull();
  });

  it('returns null when there is nothing to identify the customer by', () => {
    expect(extractCustomer(event('order.ready', { billNo: 'X' }))).toBeNull();
  });

  it('accepts a customer identified only by ERP id', () => {
    expect(
      extractCustomer(event('customer.upsert', { erpCustomerId: 'c-3' })),
    ).toMatchObject({ erpCustomerId: 'c-3' });
  });
});

describe('extractBranch', () => {
  it('reads a branch name', () => {
    expect(extractBranch(event('order.ready', orderData))).toBe('Shastri Nagar');
  });

  it('reads a branch on a customer.upsert, not just on orders', () => {
    // The bulk customer sync is how existing customers get assigned
    // to a store without waiting for their next order. extractBranch
    // reads `data.branch` regardless of event shape, so the ERP only
    // has to include the field — nothing changes on this side.
    expect(
      extractBranch(
        event('customer.upsert', {
          erpCustomerId: 'c-1',
          name: 'Asha Verma',
          phone: '919999999999',
          branch: 'Shastri Nagar',
        }),
      ),
    ).toBe('Shastri Nagar');
  });

  it('is null when absent or blank', () => {
    expect(extractBranch(event('order.ready', {}))).toBeNull();
    expect(extractBranch(event('order.ready', { branch: '  ' }))).toBeNull();
  });
});

describe('formatMoney', () => {
  it('renders whole rupees', () => {
    expect(formatMoney(4500)).toMatch(/4,500/);
    expect(formatMoney(4500)).not.toMatch(/\./);
  });

  it('treats a missing amount as zero rather than NaN', () => {
    expect(formatMoney(undefined)).toMatch(/0/);
    expect(formatMoney('nope')).toMatch(/0/);
  });
});

describe('formatDate', () => {
  it('renders an ISO date readably', () => {
    expect(formatDate('2026-10-05')).toBe('5 Oct 2026');
  });

  it('passes an unparseable value through unchanged', () => {
    expect(formatDate('next week')).toBe('next week');
  });

  it('is empty for nothing', () => {
    expect(formatDate(null)).toBe('');
    expect(formatDate('')).toBe('');
  });
});

describe('sanitizeParam', () => {
  it('removes the characters Meta rejects in a template variable', () => {
    // Meta 400s on newlines, tabs and 4+ consecutive spaces — which
    // would read as "the template is broken" rather than "this one
    // name has a line break in it".
    expect(sanitizeParam('Asha\nVerma')).toBe('Asha Verma');
    expect(sanitizeParam('Asha\tVerma')).toBe('Asha Verma');
    expect(sanitizeParam('Asha      Verma')).toBe('Asha   Verma');
    expect(sanitizeParam('  padded  ')).toBe('padded');
  });

  it('is empty for null and undefined', () => {
    expect(sanitizeParam(null)).toBe('');
    expect(sanitizeParam(undefined)).toBe('');
  });
});

const PHONE = '+91 76786 88524';

/** Every customer-facing plan needs the branch's number. */
const opts = { branchPhone: PHONE };

describe('templatePlanFor', () => {
  it('maps order.created with the full bill and the branch number last', () => {
    const plan = templatePlanFor(event('order.created', orderData), opts);
    expect(plan?.templateName).toBe('order_confirmation');
    expect(plan?.params).toEqual([
      'Asha Verma',
      'Shastri Nagar',
      'TH-0001',
      expect.stringMatching(/4,500/),
      expect.stringMatching(/2,000/),
      expect.stringMatching(/2,500/),
      '5 Oct 2026',
      PHONE,
    ]);
    // No PDF on this event, so the plain template, with no header.
    expect(plan?.documentUrl).toBeUndefined();
  });

  it('switches to the _doc template when the ERP sends a receipt PDF', () => {
    // Meta fixes a template's shape at approval, so the attachment
    // case is a different approved template, not a flag on this one.
    const plan = templatePlanFor(
      event('order.created', {
        ...orderData,
        receiptPdf: 'https://erp.taghills.com/r/TH-0001.pdf',
      }),
      opts,
    );
    expect(plan?.templateName).toBe('order_confirmation_doc');
    expect(plan?.documentUrl).toBe('https://erp.taghills.com/r/TH-0001.pdf');
    expect(plan?.documentFilename).toBe('Receipt-TH-0001.pdf');
  });

  it('ignores a non-https PDF link rather than failing at Meta', () => {
    // Meta's servers fetch the document; an http link fails there,
    // which is a much worse place to discover it.
    const plan = templatePlanFor(
      event('order.created', { ...orderData, receiptPdf: 'http://erp/r.pdf' }),
      opts,
    );
    expect(plan?.templateName).toBe('order_confirmation');
    expect(plan?.documentUrl).toBeUndefined();
  });

  it('is not fooled by an empty invoicePdf beside a real receiptPdf', () => {
    // The trap in the old `invoicePdf ?? receiptPdf`: `??` falls
    // through only on null and undefined, so an empty string won.
    // The result was indistinguishable from the ERP sending no link,
    // which is exactly the ambiguity a live test ran into.
    const plan = templatePlanFor(
      event('order.created', {
        ...orderData,
        invoicePdf: '',
        receiptPdf: 'https://erp.taghills.com/d/abc',
      }),
      opts,
    );
    expect(plan?.templateName).toBe('order_confirmation_doc');
    expect(plan?.documentUrl).toBe('https://erp.taghills.com/d/abc');
  });

  it('takes the invoice on a delivery, not a receipt that rode along', () => {
    const plan = templatePlanFor(
      event('order.delivered', {
        ...orderData,
        receiptPdf: 'https://erp.taghills.com/r/receipt.pdf',
        invoicePdf: 'https://erp.taghills.com/i/invoice.pdf',
      }),
      opts,
    );
    expect(plan?.documentUrl).toBe('https://erp.taghills.com/i/invoice.pdf');
  });

  it('falls back to the other field when the expected one is blank', () => {
    // Forgiving rather than strict: a delivery whose invoice link is
    // missing but which carries a receipt still gets an attachment.
    const plan = templatePlanFor(
      event('order.delivered', {
        ...orderData,
        invoicePdf: '   ',
        receiptPdf: 'https://erp.taghills.com/r/receipt.pdf',
      }),
      opts,
    );
    expect(plan?.documentUrl).toBe('https://erp.taghills.com/r/receipt.pdf');
  });

  it('maps order.ready with the branch and the number', () => {
    const plan = templatePlanFor(event('order.ready', orderData), opts);
    expect(plan?.templateName).toBe('order_ready');
    expect(plan?.params).toEqual([
      'Asha Verma',
      'TH-0001',
      'Shastri Nagar',
      expect.stringMatching(/2,500/),
      PHONE,
    ]);
  });

  it('maps order.delivered, attaching the invoice when there is one', () => {
    const plain = templatePlanFor(event('order.delivered', orderData), opts);
    expect(plain?.templateName).toBe('order_delivered');
    expect(plain?.params).toEqual([
      'Asha Verma',
      'TH-0001',
      'Shastri Nagar',
      PHONE,
    ]);

    const withPdf = templatePlanFor(
      event('order.delivered', {
        ...orderData,
        invoicePdf: 'https://erp.taghills.com/i/TH-0001.pdf',
      }),
      opts,
    );
    expect(withPdf?.templateName).toBe('order_delivered_invoice');
    expect(withPdf?.documentFilename).toBe('Invoice-TH-0001.pdf');
  });

  it('maps order.review only when a review link is configured', () => {
    expect(templatePlanFor(event('order.review', orderData), opts)).toBeNull();
    const plan = templatePlanFor(event('order.review', orderData), {
      ...opts,
      reviewUrl: 'https://g.page/r/review',
    });
    // The link rides on the template's URL button, not the body.
    expect(plan).toEqual({
      templateName: 'review_request',
      params: ['Asha Verma', 'Shastri Nagar', PHONE],
    });
  });

  it('maps the eye-test recall', () => {
    expect(
      templatePlanFor(
        event('customer.recall', { ...orderData, recallDate: '2026-10-02' }),
        opts,
      ),
    ).toEqual({
      templateName: 'eye_test_recall',
      params: ['Asha Verma', 'Shastri Nagar', PHONE],
    });
  });

  it('sends nothing for the two templates nobody has written yet', () => {
    // payment_receipt and birthday_wish were never submitted for
    // approval. Mapping them would mean naming a template Meta does
    // not have, which fails at the API.
    expect(
      templatePlanFor(
        event('payment.received', { ...orderData, payment: { amount: 2000 } }),
        opts,
      ),
    ).toBeNull();
    expect(
      templatePlanFor(event('customer.birthday', { name: 'Asha', phone: '91999' }), opts),
    ).toBeNull();
  });

  it('refuses to build a plan when the branch has no phone number', () => {
    // Meta rejects an empty parameter, and "call us on " is worse
    // than no message. The caller turns this into a reason naming
    // the store that needs a number.
    expect(templatePlanFor(event('order.created', orderData))).toBeNull();
    expect(
      templatePlanFor(event('order.created', orderData), { branchPhone: '   ' }),
    ).toBeNull();
  });

  it('sends nothing for ping and customer.upsert', () => {
    // These two never needed a phone number either.
    expect(templatePlanFor(event('ping', {}))).toBeNull();
    expect(templatePlanFor(event('customer.upsert', orderData.customer))).toBeNull();
  });

  it('falls back to a greeting when the customer has no name', () => {
    const plan = templatePlanFor(event('order.ready', { ...orderData, customer: { phone: '91999' } }), opts);
    expect(plan?.params[0]).toBe('there');
  });
});
