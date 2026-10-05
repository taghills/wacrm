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

describe('templatePlanFor', () => {
  it('maps order.created', () => {
    const plan = templatePlanFor(event('order.created', orderData));
    expect(plan?.templateName).toBe('order_confirmation');
    expect(plan?.params[0]).toBe('Asha Verma');
    expect(plan?.params[1]).toBe('TH-0001');
    expect(plan?.params[4]).toBe('5 Oct 2026');
  });

  it('maps order.ready with the branch', () => {
    const plan = templatePlanFor(event('order.ready', orderData));
    expect(plan?.templateName).toBe('order_ready');
    expect(plan?.params).toHaveLength(4);
    expect(plan?.params[2]).toBe('Shastri Nagar');
  });

  it('maps payment.received using the payment amount, not the total', () => {
    const plan = templatePlanFor(
      event('payment.received', { ...orderData, payment: { amount: 2000, mode: 'UPI' } }),
    );
    expect(plan?.templateName).toBe('payment_receipt');
    expect(plan?.params[1]).toMatch(/2,000/);
    expect(plan?.params[3]).toMatch(/2,500/);
  });

  it('maps order.delivered only when a review link is configured', () => {
    expect(templatePlanFor(event('order.delivered', orderData))).toBeNull();
    const plan = templatePlanFor(event('order.delivered', orderData), {
      reviewUrl: 'https://g.page/r/review',
    });
    expect(plan).toEqual({
      templateName: 'thank_you_feedback',
      params: ['Asha Verma', 'https://g.page/r/review'],
    });
  });

  it('maps the two marketing events', () => {
    expect(
      templatePlanFor(event('customer.birthday', { name: 'Asha', phone: '91999' })),
    ).toEqual({ templateName: 'birthday_wish', params: ['Asha'] });
    expect(
      templatePlanFor(event('customer.recall', { ...orderData, recallDate: '2026-10-02' })),
    ).toEqual({ templateName: 'eye_test_recall', params: ['Asha Verma', 'Shastri Nagar'] });
  });

  it('sends nothing for ping and customer.upsert', () => {
    expect(templatePlanFor(event('ping', {}))).toBeNull();
    expect(templatePlanFor(event('customer.upsert', orderData.customer))).toBeNull();
  });

  it('falls back to a greeting when the customer has no name', () => {
    const plan = templatePlanFor(event('customer.birthday', { phone: '91999' }));
    expect(plan?.params[0]).toBe('there');
  });
});
