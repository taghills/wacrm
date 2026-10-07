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
  /**
   * The review request, sent some days AFTER delivery. It is a
   * separate event rather than a delay on `order.delivered` because
   * the CRM has no scheduler of its own for ERP events: the ERP
   * decides when enough days have passed and emits this then.
   */
  'order.review',
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
  /**
   * A review request is not about completing the customer's order, so
   * it is marketing both in Meta's eyes and in ours: STOP silences
   * it, and it is submitted as MARKETING to avoid a rejection.
   */
  'order.review',
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
/**
 * A template parameter that is never empty.
 *
 * Meta rejects an empty text parameter with "(#131008) Required
 * parameter is missing" — it does not distinguish a blank value from
 * an absent one. A live demo order failed exactly this way: the order
 * had no expected delivery date, `formatDate` correctly returned '',
 * and the whole message was refused over one missing field.
 *
 * Every parameter now carries a fallback, so a gap in the ERP's data
 * costs the customer one vague line rather than the entire message.
 */
export function orFallback(value: string, fallback: string): string {
  return value.trim() ? value : fallback;
}

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
  /**
   * URL for a DOCUMENT header, when this plan chose the `_doc`
   * variant. Meta fixes a template's shape at approval: a template
   * approved with a document header must carry one on EVERY send, and
   * one approved without can never gain one. So "attach the PDF when
   * the ERP gives us a link" is two approved templates, not one, and
   * this field is what tells them apart.
   */
  documentUrl?: string;
  /** Filename the customer sees on the attachment. */
  documentFilename?: string;
}

export interface TemplatePlanOptions {
  /** Account currency for money variables. */
  currency?: string;
  /**
   * Where `review_request`'s button sends the customer. Unset means
   * that one event type cannot be delivered; the caller skips it with
   * a reason rather than sending a template with an empty variable.
   */
  reviewUrl?: string | null;
  /**
   * The serving branch's own contact number, as the customer should
   * dial it. Every approved template closes by naming it, so a plan
   * cannot be built without one — see `requiresBranchPhone`. The
   * caller resolves it from the store matched to the event's branch;
   * it is NOT formatted or validated here, because a shop's number is
   * printed for a human to read, not parsed.
   */
  branchPhone?: string | null;
}

/**
 * Event types whose approved template closes with the branch's phone
 * number, and therefore cannot be sent until that store has one.
 *
 * Every customer-facing template does. The constant exists so the
 * caller can say WHICH store needs a number rather than failing with
 * a bare "no template mapped", and so an empty parameter — which Meta
 * rejects outright — can never reach a send.
 */
export function requiresBranchPhone(type: string): boolean {
  return type !== 'ping' && type !== 'customer.upsert';
}

/**
 * The PDF the ERP attached to this event, if any.
 *
 * `receiptPdf` rides on `order.created`, `invoicePdf` on
 * `order.delivered`. Both are optional: the ERP did not have them
 * when this integration was first built, and an order whose PDF is
 * still rendering must not hold up its confirmation message.
 */
export function extractDocumentUrl(event: ErpEvent): string | null {
  const data = event.data;

  // Picked by EVENT TYPE, not by whichever field happens to be
  // present. The previous `data.invoicePdf ?? data.receiptPdf` had a
  // trap: `??` only falls through on null and undefined, so an ERP
  // sending `invoicePdf: ""` beside a perfectly good `receiptPdf`
  // would take the empty string and silently send no attachment —
  // indistinguishable from the ERP sending no link at all.
  const primary = event.type === 'order.delivered'
    ? data.invoicePdf
    : data.receiptPdf;
  const secondary = event.type === 'order.delivered'
    ? data.receiptPdf
    : data.invoicePdf;

  return httpsUrl(primary) ?? httpsUrl(secondary);
}

/**
 * A value we are willing to hand Meta as a document link.
 *
 * Only https: a document header is fetched by Meta's servers, so an
 * http link fails there rather than here, which is a far worse place
 * to find out. Blank and non-string both read as absent, so "no PDF"
 * has one meaning however the ERP expresses it.
 */
function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const url = value.trim();
  if (!url.toLowerCase().startsWith('https://')) return null;
  return url;
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
  const phone = sanitizeParam(options.branchPhone ?? '');

  // Fail closed rather than send a template with a blank variable:
  // Meta rejects an empty parameter, and a message reading "call us
  // on " is worse than no message at all. The caller turns this into
  // a reason naming the store that needs a number.
  if (requiresBranchPhone(event.type) && !phone) return null;

  const pdf = extractDocumentUrl(event);

  switch (event.type) {
    case 'order.created': {
      const params = [
        name,
        orFallback(branch, 'TAGHills'),
        orFallback(billNo, '-'),
        formatMoney(data.grandTotal, currency),
        formatMoney(data.paid, currency),
        formatMoney(data.balance, currency),
        // An order without a promised date is normal; refusing to send
        // the confirmation over it is not.
        orFallback(sanitizeParam(formatDate(data.deliveryDate)), 'To be confirmed'),
        phone,
      ];
      // Two approved templates, identical wording, differing only in
      // the document header. See TemplatePlan.documentUrl.
      return pdf
        ? {
            templateName: 'order_confirmation_doc',
            params,
            documentUrl: pdf,
            documentFilename: receiptFilename(data.billNo),
          }
        : { templateName: 'order_confirmation', params };
    }

    case 'order.ready':
      return {
        templateName: 'order_ready',
        params: [
          name,
          orFallback(billNo, '-'),
          orFallback(branch, 'TAGHills'),
          formatMoney(data.balance, currency),
          phone,
        ],
      };

    case 'order.delivered': {
      const params = [
        name,
        orFallback(billNo, '-'),
        orFallback(branch, 'TAGHills'),
        phone,
      ];
      return pdf
        ? {
            templateName: 'order_delivered_invoice',
            params,
            documentUrl: pdf,
            documentFilename: invoiceFilename(data.billNo),
          }
        : { templateName: 'order_delivered', params };
    }

    case 'order.review': {
      const reviewUrl = options.reviewUrl?.trim();
      if (!reviewUrl) return null;
      // The review link rides on the template's URL BUTTON, not the
      // body, so it is not a body param. The caller passes it through
      // buttonParams.
      return {
        templateName: 'review_request',
        params: [name, orFallback(branch, 'TAGHills'), phone],
      };
    }

    case 'customer.recall':
      return {
        templateName: 'eye_test_recall',
        params: [name, orFallback(branch, 'TAGHills'), phone],
      };

    /**
     * Deliberately unmapped. `payment_receipt` and `birthday_wish`
     * were never written or submitted for approval, and a send
     * naming a template Meta has not approved fails at the API. The
     * caller records "no template mapped", which is the honest
     * reason: these two are off until someone writes them.
     */
    case 'payment.received':
    case 'customer.birthday':
      return null;

    default:
      return null;
  }
}

/**
 * The plain template that carries the same wording as an attachment
 * variant, for when the variant is not approved yet.
 *
 * Returns null for a template that has no plain twin.
 */
export function plainTemplateFor(templateName: string): string | null {
  if (templateName === 'order_confirmation_doc') return 'order_confirmation';
  if (templateName === 'order_delivered_invoice') return 'order_delivered';
  return null;
}

/** `Receipt-TH-0001.pdf`, or a generic name when there is no bill no. */
function receiptFilename(billNo: unknown): string {
  const no = typeof billNo === 'string' ? billNo.trim() : '';
  return no ? `Receipt-${no}.pdf` : 'Receipt.pdf';
}

/** `Invoice-TH-0001.pdf`, or a generic name when there is no bill no. */
function invoiceFilename(billNo: unknown): string {
  const no = typeof billNo === 'string' ? billNo.trim() : '';
  return no ? `Invoice-${no}.pdf` : 'Invoice.pdf';
}
