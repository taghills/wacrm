// ============================================================
// The review request's delay.
//
// `order.delivered` arrives the moment an order is handed over, but
// the review request should not. So delivery queues a row here, due
// a few days out, and the cron drains it.
//
// Why the CRM owns this rather than the ERP: the delay is a number
// the shop owner wants to change without asking a developer, and
// the setting it comes from lives here (migration 052). The ERP can
// still send `order.review` itself — if it does, the queued row is
// marked superseded rather than sending twice.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { reviewDueAt } from './message-settings';

/** Row shape the drain reads. Narrow on purpose. */
export interface ReviewQueueRow {
  id: string;
  account_id: string;
  contact_id: string;
  erp_order_key: string;
  branch: string | null;
  due_at: string;
}

/**
 * The key that makes one order's review request unique.
 *
 * Bill number when the event carries one, else the ERP's order id.
 * Falling back to the order id matters: an order can reach delivery
 * before it is billed, and keying on an empty string would collapse
 * every such order in the account into one row.
 */
export function reviewOrderKey(data: Record<string, unknown>): string | null {
  const billNo = typeof data.billNo === 'string' ? data.billNo.trim() : '';
  if (billNo) return billNo;
  const orderId =
    typeof data.erpOrderId === 'string' ? data.erpOrderId.trim() : '';
  return orderId || null;
}

/**
 * Queue the review request owed for a delivered order.
 *
 * Idempotent on `(account_id, erp_order_key)`: the ERP re-sending
 * `order.delivered`, or a replayed batch, updates the due date on
 * the existing row instead of queueing a second ask. A row already
 * `sent` is left alone — the customer has had their message, and a
 * redelivery is not a reason to ask again.
 *
 * Returns the day it falls due, for the event ledger to record, or
 * null when nothing was queued.
 */
export async function enqueueReviewRequest(
  db: SupabaseClient,
  params: {
    accountId: string;
    contactId: string;
    orderKey: string;
    branch: string | null;
    delayDays: number;
    now?: Date;
  },
): Promise<Date | null> {
  const dueAt = reviewDueAt(params.delayDays, params.now);

  const { data: existing } = await db
    .from('erp_review_queue')
    .select('id, status')
    .eq('account_id', params.accountId)
    .eq('erp_order_key', params.orderKey)
    .maybeSingle();

  if (existing?.status && existing.status !== 'pending') {
    // Already sent, skipped or failed. Re-queueing a sent row would
    // ask the same customer twice for the same order.
    return null;
  }

  const { error } = await db.from('erp_review_queue').upsert(
    {
      account_id: params.accountId,
      contact_id: params.contactId,
      erp_order_key: params.orderKey,
      branch: params.branch,
      due_at: dueAt.toISOString(),
      status: 'pending',
      detail: null,
    },
    { onConflict: 'account_id,erp_order_key' },
  );

  if (error) {
    console.warn('[erp] review queue upsert failed:', error.message);
    return null;
  }
  return dueAt;
}

/**
 * Mark an order's queued review request as superseded.
 *
 * Called when the ERP sends `order.review` for an order the CRM had
 * already queued. Without this the customer would get two asks: one
 * from the ERP's own timing and one from ours.
 */
export async function supersedeQueuedReview(
  db: SupabaseClient,
  accountId: string,
  orderKey: string,
): Promise<void> {
  const { error } = await db
    .from('erp_review_queue')
    .update({
      status: 'skipped',
      detail: 'the ERP sent its own order.review for this order',
    })
    .eq('account_id', accountId)
    .eq('erp_order_key', orderKey)
    .eq('status', 'pending');
  if (error) {
    console.warn('[erp] review supersede failed:', error.message);
  }
}

/**
 * Pending rows that have come due, oldest first.
 *
 * `limit` bounds one drain so a backlog cannot run the request past
 * its timeout; the next run picks up the rest.
 */
export async function dueReviewRequests(
  db: SupabaseClient,
  limit: number,
  now: Date = new Date(),
): Promise<ReviewQueueRow[]> {
  const { data, error } = await db
    .from('erp_review_queue')
    .select('id, account_id, contact_id, erp_order_key, branch, due_at')
    .eq('status', 'pending')
    .lte('due_at', now.toISOString())
    .order('due_at', { ascending: true })
    .limit(limit);

  if (error) {
    console.warn('[erp] review queue read failed:', error.message);
    return [];
  }
  return (data ?? []) as ReviewQueueRow[];
}

/** Record how one queued review request ended. */
export async function settleReviewRequest(
  db: SupabaseClient,
  id: string,
  status: 'sent' | 'skipped' | 'failed',
  detail: string,
): Promise<void> {
  const { error } = await db
    .from('erp_review_queue')
    .update({
      status,
      detail,
      sent_at: status === 'sent' ? new Date().toISOString() : null,
    })
    .eq('id', id);
  if (error) {
    console.warn('[erp] review queue settle failed:', error.message);
  }
}
