// ============================================================
// What the ERP is told about each event it sent us.
//
// Until now `POST /api/erp/events` answered `{}` for a whole batch
// unless something threw, so an event the CRM deliberately SKIPPED —
// branch held back by the rollout gate, store with no phone number,
// branch matching no store, template not approved — looked exactly
// like a message that reached the customer. The ERP wrote down
// "sent" and nobody learned otherwise until a customer complained.
//
// So every event now comes back with its own outcome and, when it is
// not a send, the reason in words a person can act on.
//
// The three values are the ERP's vocabulary, not ours. Ours has
// `done`, which is not the same as `sent`: `ping` and
// `customer.upsert` both succeed having sent nothing at all. Calling
// those "sent" would re-create, in a new place, the exact confusion
// this module exists to remove.
// ============================================================

import type { ErpEventOutcome } from './process';

/** The status vocabulary the ERP reads. */
export type ErpReportStatus = 'sent' | 'skipped' | 'failed';

/** One event's outcome, as the ERP receives it. */
export interface ErpEventReport {
  eventId: string;
  status: ErpReportStatus;
  /**
   * Why, in words meant for shop staff rather than a developer.
   * Always present: a `skipped` with no reason is only marginally
   * better than the silence this replaces.
   */
  reason: string;
}

/**
 * The reason to report when an outcome somehow carries none.
 *
 * Every skip path names its reason today, so this should be
 * unreachable. It exists because "every skip has a reason" is a
 * promise made to another team, and a promise kept by convention
 * alone is one bad merge from being broken.
 */
export const UNEXPLAINED = 'no reason was recorded — please report this';

/**
 * Turn one processed event into the ERP's view of it.
 *
 * `sent` requires a message id. That is the only fact that proves a
 * customer received something: the status alone cannot distinguish
 * "order confirmation delivered to Meta" from "contact synced, by
 * design no message".
 */
export function reportFor(eventId: string, outcome: ErpEventOutcome): ErpEventReport {
  const reason = outcome.detail?.trim() || UNEXPLAINED;
  if (outcome.status === 'failed') return { eventId, status: 'failed', reason };
  if (outcome.status === 'skipped') return { eventId, status: 'skipped', reason };
  return {
    eventId,
    status: outcome.whatsappMessageId ? 'sent' : 'skipped',
    reason,
  };
}

/**
 * The ERP's view of an event we have already settled.
 *
 * A replayed batch must still be answered — reporting nothing for an
 * id the ERP asked about would leave it exactly as blind as before —
 * so the stored outcome is read back from the ledger.
 *
 * The one thing the ledger cannot tell us is whether a `done` row
 * sent a message, because it does not store the message id yet. A
 * replayed `ping` or `customer.upsert` therefore reads as `sent`.
 * Stage 2 adds that column and this goes away; until then the reason
 * text says plainly what happened ("contact synced"), and a replay of
 * a non-sending event is not a case anyone is watching for.
 */
export function reportForSettled(
  eventId: string,
  status: string,
  detail: string | null,
): ErpEventReport {
  const reason = detail?.trim() || UNEXPLAINED;
  if (status === 'skipped') return { eventId, status: 'skipped', reason };
  if (status === 'failed') return { eventId, status: 'failed', reason };
  return { eventId, status: 'sent', reason };
}
