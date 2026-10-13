// ============================================================
// "What happened to that customer's message?"
//
// The answer lives in two halves that never met:
//
//   erp_events  WHY the CRM did or did not send — held back by the
//               rollout gate, a store with no phone number, a branch
//               matching no store, a template not yet approved.
//   messages    what META did once it was sent — sent, delivered,
//               read, failed, with Meta's own reason.
//
// A staff member does not care which half their answer comes from,
// and should never have to know there are two. This module collapses
// them into one outcome per row.
//
// Pure: no database, no request. The SQL and the access rule live in
// the route; what a row MEANS is decided here, where it can be
// tested exhaustively.
// ============================================================

/**
 * What a reader sees, worst news first.
 *
 * `not_sent` and `failed` are deliberately separate. "We decided not
 * to" and "we tried and WhatsApp refused" lead to different actions —
 * one is a setting someone can change, the other is a number that
 * may be wrong — and collapsing them into "didn't arrive" is how a
 * fixable problem looks like bad luck.
 */
export type ActivityOutcome =
  | 'failed'
  | 'not_sent'
  | 'sent'
  | 'delivered'
  | 'read';

/** Every outcome, worst first — the order the filter chips use. */
export const ACTIVITY_OUTCOMES: readonly ActivityOutcome[] = [
  'failed',
  'not_sent',
  'sent',
  'delivered',
  'read',
] as const;

export function isActivityOutcome(value: unknown): value is ActivityOutcome {
  return (
    typeof value === 'string' &&
    (ACTIVITY_OUTCOMES as readonly string[]).includes(value)
  );
}

/** The ledger row, joined, as the route reads it. */
export interface ActivityRow {
  eventId: string;
  eventType: string;
  /** The ledger's own status: 'done' | 'skipped' | 'failed'. */
  erpStatus: string;
  /** Why, in the words the ledger recorded. */
  detail: string | null;
  branch: string | null;
  /** The bill number, else the ERP's order id. What people quote. */
  orderRef: string | null;
  receivedAt: string;
  contactName: string | null;
  contactId: string | null;
  /** Meta's delivery state, when the row reached a message at all. */
  messageStatus: string | null;
  messageError: string | null;
}

/** One row as the screen shows it. */
export interface ActivityEntry extends ActivityRow {
  outcome: ActivityOutcome;
  /** The one line under the row. Never empty. */
  reason: string;
}

/**
 * Meta's delivery states, in the order they happen. A later state
 * never regresses to an earlier one, so the message's own status
 * wins over "we handed it over" whenever we have it.
 */
const DELIVERY: Record<string, ActivityOutcome> = {
  sending: 'sent',
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  failed: 'failed',
};

/**
 * What this row should say happened.
 *
 * Order matters. Meta's verdict is the most recent news and wins
 * when there is one; otherwise the ledger's own outcome stands. A
 * row the CRM recorded as `done` but which never reached a message —
 * `ping`, `customer.upsert` — is NOT "sent": nothing was, and saying
 * otherwise is the exact confusion the ERP's own report had to be
 * fixed for.
 */
export function outcomeFor(row: ActivityRow): ActivityOutcome {
  if (row.erpStatus === 'failed') return 'failed';
  const delivery = row.messageStatus ? DELIVERY[row.messageStatus] : undefined;
  if (delivery) return delivery;
  if (row.erpStatus === 'skipped') return 'not_sent';
  return row.detail?.startsWith('sent ') ? 'sent' : 'not_sent';
}

/**
 * The line a shop assistant reads.
 *
 * Meta's reason wins for a failure, because "the CRM sent it" is
 * true and useless when the number is not on WhatsApp. Otherwise the
 * ledger's own words, which already name the store or the setting to
 * change.
 */
export function reasonFor(row: ActivityRow): string {
  if (row.messageStatus === 'failed' && row.messageError?.trim()) {
    return row.messageError.trim();
  }
  const detail = row.detail?.trim();
  if (detail) return detail;
  return 'no reason was recorded';
}

export function entryFor(row: ActivityRow): ActivityEntry {
  return { ...row, outcome: outcomeFor(row), reason: reasonFor(row) };
}

/**
 * Count per outcome, so "3 failed today" is visible without reading
 * the list. Every outcome is present, including the zeroes: a
 * missing key reads as "no data" and a zero reads as "nothing wrong",
 * and only one of those is what an empty count means.
 */
export function countByOutcome(
  entries: readonly ActivityEntry[],
): Record<ActivityOutcome, number> {
  const counts = Object.fromEntries(
    ACTIVITY_OUTCOMES.map((o) => [o, 0]),
  ) as Record<ActivityOutcome, number>;
  for (const entry of entries) counts[entry.outcome]++;
  return counts;
}

/**
 * Event types that never send a message and would otherwise fill the
 * screen with rows nobody is looking for. A contact sync is not a
 * message that failed to arrive.
 */
const SILENT_EVENTS = new Set(['ping', 'customer.upsert']);

export function isMessageEvent(eventType: string): boolean {
  return !SILENT_EVENTS.has(eventType);
}
