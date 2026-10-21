// ============================================================
// POST /api/erp/inbox-counts — request parsing and result shaping.
//
// Pure, no I/O, so the route stays a thin shell around things that
// are tested directly (the same split the rest of the ERP code
// uses).
// ============================================================

import { isAcknowledgement } from './acknowledgement';

export interface InboxCountsRequest {
  /** Branch to scope the counts to; null means the whole account. */
  branch: string | null;
}

export interface InboxCounts {
  /** Conversations with an unopened incoming message. */
  unread: number;
  /** Conversations whose last message is the customer's and needs an answer (not just "ok" / "thanks"). */
  awaitingReply: number;
}

/**
 * Validate `{ "branch": "…" | null }`.
 *
 * Returns null when the body is something else entirely — the
 * caller turns that into a 400 rather than quietly counting the
 * whole account, because a till asking for one branch and being
 * given the company total is a wrong number nobody would question.
 *
 * A missing body, `{}`, and an explicit null all mean the whole
 * account: the ERP sends the first two for the owner's overview.
 */
export function parseInboxCountsBody(input: unknown): InboxCountsRequest | null {
  if (input === null || input === undefined) return { branch: null };
  if (typeof input !== 'object' || Array.isArray(input)) return null;

  const raw = (input as Record<string, unknown>).branch;
  if (raw === undefined || raw === null) return { branch: null };
  if (typeof raw !== 'string') return null;

  const trimmed = raw.trim();
  return { branch: trimmed.length > 0 ? trimmed : null };
}

/**
 * Read the one row `erp_inbox_counts` returns.
 *
 * Postgres counts are BIGINT, and a bigint can arrive as a JSON
 * string rather than a number depending on the client — `Number()`
 * over both, with a 0 floor, so a count can never reach the ERP as
 * `"12"` or NaN and render as "NaN customers waiting".
 */
export function readInboxCounts(rpcResult: unknown): InboxCounts {
  const row = Array.isArray(rpcResult) ? rpcResult[0] : rpcResult;
  const record = (row ?? {}) as Record<string, unknown>;
  return {
    unread: toCount(record.unread),
    awaitingReply: toCount(record.awaiting_reply),
  };
}

/**
 * `awaitingReply` from the rows `erp_inbox_waiting` (migration 058)
 * returns: conversations whose last message is the customer's, less
 * the ones where that message is only "ok" / "thanks" / 👍.
 */
export function countAwaitingReply(rpcResult: unknown): number {
  const rows = Array.isArray(rpcResult) ? rpcResult : [];
  return rows.filter((row) => {
    const r = (row ?? {}) as Record<string, unknown>;
    return !isAcknowledgement(
      typeof r.content_type === 'string' ? r.content_type : null,
      typeof r.content_text === 'string' ? r.content_text : null,
    );
  }).length;
}

function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}
