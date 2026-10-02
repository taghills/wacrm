// ============================================================
// The TAGHills ERP event vocabulary — parsing and mapping, with no
// database or network in sight.
//
// The ERP sends *events*, never message text: "order 1042 is ready",
// not "Hi Asha, your glasses are ready". Choosing the words, the
// language and the Meta-approved template is this CRM's job, and
// this module is where that choice lives. Everything here is pure so
// the mapping can be tested exhaustively without a database, a Meta
// token, or a running Next server.
//
// The side-effecting half (find the contact, link the store, send,
// record the event id) is `process.ts`.
// ============================================================

/** One event as the ERP sends it. */
export interface ErpEvent {
  id: string;
  type: string;
  occurredAt?: string;
  data: Record<string, unknown>;
}

/** The ERP's customer object, as it appears in `data`. */
export interface ErpCustomer {
  erpCustomerId?: string;
  name?: string;
  phone?: string;
  email?: string | null;
  city?: string | null;
  birthDate?: string | null;
  totalSpent?: number | null;
  lastPurchase?: string | null;
  pendingReferralDiscountPercent?: number | null;
}

/**
 * Event types we act on. Anything else is recorded as 'skipped'
 * rather than failed: an unknown type means the ERP shipped a
 * feature we have not built yet, and making it retry 8 times and
 * then alarm the ERP's operator helps nobody.
 */
export const KNOWN_EVENT_TYPES = [
  'ping',
  'customer.upsert',
  'order.created',
  'order.ready',
  'order.delivered',
  'payment.received',
  'customer.birthday',
  'customer.recall',
] as const;

export type ErpEventType = (typeof KNOWN_EVENT_TYPES)[number];

/** The ERP's documented cap: 100 events per batch. */
export const MAX_EVENTS_PER_BATCH = 100;

export function isKnownEventType(type: string): type is ErpEventType {
  return (KNOWN_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * Marketing vs transactional.
 *
 * WhatsApp policy (and plain decency) treat these differently: a
 * birthday wish or an eye-test reminder is marketing and must honour
 * an opt-out; "your order is ready" is a service message about
 * something the customer actively bought and is not suppressed by
 * one.
 */
export const MARKETING_EVENT_TYPES: readonly string[] = [
  'customer.birthday',
  'customer.recall',
];

export function isMarketingEvent(type: string): boolean {
  return MARKETING_EVENT_TYPES.includes(type);
}

// ------------------------------------------------------------
// Parsing
// ------------------------------------------------------------

/**
 * Pull a well-formed event list out of an arbitrary parsed body.
 *
 * Returns null when the body is not a batch at all — that is a 400,
 * distinct from "a batch whose individual events failed", which is a
 * 200 with a `failed` array.
 *
 * Events missing an `id` or a `type` are dropped rather than failed:
 * without an id there is nothing to report back as failed and
 * nothing to dedupe on, so the only honest handling is to ignore
 * them and say so in the log.
 */
export function parseEventBatch(body: unknown): ErpEvent[] | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const rawEvents = (body as { events?: unknown }).events;
  if (!Array.isArray(rawEvents)) return null;

  const events: ErpEvent[] = [];
  for (const raw of rawEvents.slice(0, MAX_EVENTS_PER_BATCH)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const candidate = raw as Record<string, unknown>;
    const id = candidate.id;
    const type = candidate.type;
    if (typeof id !== 'string' && typeof id !== 'number') continue;
    if (typeof type !== 'string' || type.length === 0) continue;
    const data =
      candidate.data && typeof candidate.data === 'object' && !Array.isArray(candidate.data)
        ? (candidate.data as Record<string, unknown>)
        : {};
    events.push({
      id: String(id),
      type,
      occurredAt:
        typeof candidate.occurredAt === 'string' ? candidate.occurredAt : undefined,
      data,
    });
  }
  return events;
}

/**
 * The customer an event is about.
 *
 * `customer.upsert` and `customer.birthday` carry the customer
 * fields at the top level of `data`; the order-shaped events nest
 * them under `data.customer`. Normalising here means the rest of the
 * pipeline never has to ask which shape it is holding.
 */
export function extractCustomer(event: ErpEvent): ErpCustomer | null {
  const nested = event.data.customer;
  const source =
    nested && typeof nested === 'object' && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : event.data;

  const phone = typeof source.phone === 'string' ? source.phone.trim() : '';
  const erpCustomerId =
    typeof source.erpCustomerId === 'string' ? source.erpCustomerId.trim() : '';
  if (!phone && !erpCustomerId) return null;

  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;

  return {
    erpCustomerId: erpCustomerId || undefined,
    name: str(source.name) ?? undefined,
    phone: phone || undefined,
    email: str(source.email),
    city: str(source.city),
    birthDate: str(source.birthDate),
    totalSpent: num(source.totalSpent),
    lastPurchase: str(source.lastPurchase),
    pendingReferralDiscountPercent: num(source.pendingReferralDiscountPercent),
  };
}

/** The branch name on an order-shaped event, if any. */
export function extractBranch(event: ErpEvent): string | null {
  const branch = event.data.branch;
  if (typeof branch !== 'string') return null;
  const trimmed = branch.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ------------------------------------------------------------
// Formatting
// ------------------------------------------------------------

/**
 * Money, as it appears inside a WhatsApp template variable.
 *
 * Locale is pinned to `en-IN` rather than the server's default so
 * the output is identical in CI, on the dev machine and in
 * production — a template variable that renders "₹4,500" locally and
 * "₹4,500.00" on the host is the kind of difference nobody notices
 * until a customer screenshots it.
 */
export function formatMoney(value: unknown, currency = 'INR'): string {
  const amount = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${currency} ${amount}`;
  }
}

/**
 * Dates, as they appear inside a template variable: "5 Oct 2026".
 *
 * Returns the raw string unchanged if it is not a parseable date, so
 * an ERP that starts sending "next week" degrades to showing that
 * rather than "Invalid Date".
 */
export function formatDate(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  }).format(parsed);
}

/**
 * Make a string safe to pass as a WhatsApp template variable.
 *
 * Meta rejects a send whose parameter contains a newline, a tab, or
 * four or more consecutive spaces. An ERP field (a customer name
 * pasted from a form, an address) can contain all three, and the
 * resulting 400 would look like "the template is broken" rather than
 * "this one customer's name has a line break in it".
 */
export function sanitizeParam(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return text.replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim();
}

// ------------------------------------------------------------
// Event -> template
// ------------------------------------------------------------

/** A decision to send one approved template with these body values. */
export interface TemplatePlan {
  templateName: string;
  /** Positional body params, already sanitised: {{1}}, {{2}}, … */
  params: string[];
}

export interface TemplatePlanOptions {
  /** Account currency for money variables. */
  currency?: string;
  /**
   * Where `thank_you_feedback` sends the customer to leave a review.
   * Unset means that one event type cannot be delivered; the caller
   * skips it with a reason rather than sending a template with an
   * empty variable.
   */
  reviewUrl?: string | null;
}

/**
 * Which approved template answers which event, and with what.
 *
 * This table is the integration's editorial surface: changing a
 * template name or a variable order here is how you change what
 * customers receive. The names must match APPROVED templates in the
 * CRM's own template list (Settings -> WhatsApp -> Templates) — the
 * send fails loudly if one is missing or still pending approval,
 * which is the right failure: an unapproved template cannot be sent
 * by anyone.
 *
 * Returns null for event types that deliberately send nothing
 * (`ping`, `customer.upsert`).
 */
export function templatePlanFor(
  event: ErpEvent,
  options: TemplatePlanOptions = {},
): TemplatePlan | null {
  const currency = options.currency || 'INR';
  const customer = extractCustomer(event);
  const name = sanitizeParam(customer?.name || 'there');
  const data = event.data;
  const billNo = sanitizeParam(data.billNo);
  const branch = sanitizeParam(extractBranch(event) ?? '');

  switch (event.type) {
    case 'order.created':
      return {
        templateName: 'order_confirmation',
        params: [
          name,
          billNo,
          formatMoney(data.grandTotal, currency),
          formatMoney(data.balance, currency),
          sanitizeParam(formatDate(data.deliveryDate)),
        ],
      };

    case 'order.ready':
      return {
        templateName: 'order_ready',
        params: [name, billNo, branch, formatMoney(data.balance, currency)],
      };

    case 'order.delivered': {
      const reviewUrl = options.reviewUrl?.trim();
      if (!reviewUrl) return null;
      return {
        templateName: 'thank_you_feedback',
        params: [name, sanitizeParam(reviewUrl)],
      };
    }

    case 'payment.received': {
      const payment =
        data.payment && typeof data.payment === 'object' && !Array.isArray(data.payment)
          ? (data.payment as Record<string, unknown>)
          : {};
      return {
        templateName: 'payment_receipt',
        params: [
          name,
          formatMoney(payment.amount, currency),
          billNo,
          formatMoney(data.balance, currency),
        ],
      };
    }

    case 'customer.birthday':
      return { templateName: 'birthday_wish', params: [name] };

    case 'customer.recall':
      return { templateName: 'eye_test_recall', params: [name, branch] };

    default:
      return null;
  }
}
