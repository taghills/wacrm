// ============================================================
// GET /api/messages/activity — the Message activity list.
//
// Who sees what is NOT decided here. The query runs on the caller's
// own Supabase client, so migration 055's policy applies: an owner or
// admin sees the whole account, an agent sees only the rows whose
// customer their store can access (migration 043's
// `can_access_contact`). Filtering in TypeScript instead would put a
// staff-isolation boundary in a place a future `select` could walk
// straight past.
//
// Deliberately NOT using supabaseAdmin. Every other read-only screen
// in this app that serves staff does the same; the ERP routes use the
// admin client because they have no user at all.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  countByOutcome,
  entryFor,
  isActivityOutcome,
  isMessageEvent,
  type ActivityEntry,
  type ActivityRow,
} from '@/lib/messages/activity';

/**
 * Rows per page. Generous because the screen's job is "scan today",
 * and bounded because the ledger grows forever.
 */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export async function GET(request: Request) {
  let ctx;
  try {
    // 'viewer' — the lowest role that has a login. The database
    // decides which ROWS; this only decides that a stranger gets
    // nothing.
    ctx = await requireRole('viewer');
  } catch (err) {
    return toErrorResponse(err);
  }

  const url = new URL(request.url);
  const outcomeFilter = url.searchParams.get('outcome');
  const branchFilter = url.searchParams.get('branch');
  const since = url.searchParams.get('since');
  const limit = Math.min(
    Math.max(Number(url.searchParams.get('limit')) || DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );

  let query = ctx.supabase
    .from('erp_events')
    .select(
      'event_id, event_type, status, detail, branch, received_at, contact_id, ' +
        'contacts(name), messages(status, error_title, error_details)',
    )
    .eq('account_id', ctx.accountId)
    .order('received_at', { ascending: false })
    // One page of MESSAGE events. The silent types are filtered
    // below rather than in SQL so the two lists cannot drift; the
    // headroom covers a page that is mostly contact syncs.
    .limit(limit * 3);

  if (branchFilter) query = query.eq('branch', branchFilter);
  if (since) query = query.gte('received_at', since);

  const { data, error } = await query;
  if (error) {
    return NextResponse.json(
      { error: `Could not read the message activity: ${error.message}` },
      { status: 500 },
    );
  }

  const entries: ActivityEntry[] = [];
  for (const raw of (data ?? []) as unknown[]) {
    const row = raw as Record<string, unknown>;
    const eventType = String(row.event_type ?? '');
    if (!isMessageEvent(eventType)) continue;

    // PostgREST returns an embedded one-to-one as an object, but as
    // an array when it cannot prove the relationship is unique.
    // Tolerating both keeps this from breaking on a schema change
    // that adds a second foreign key.
    const contact = first(row.contacts);
    const message = first(row.messages);

    const activity: ActivityRow = {
      eventId: String(row.event_id ?? ''),
      eventType,
      erpStatus: String(row.status ?? ''),
      detail: (row.detail as string | null) ?? null,
      branch: (row.branch as string | null) ?? null,
      receivedAt: String(row.received_at ?? ''),
      contactId: (row.contact_id as string | null) ?? null,
      contactName: (contact?.name as string | null) ?? null,
      messageStatus: (message?.status as string | null) ?? null,
      messageError: messageError(message),
    };
    entries.push(entryFor(activity));
  }

  // Counted BEFORE the outcome filter: "3 failed" has to stay
  // visible while you are looking at the delivered ones, or the
  // filter hides the number it exists to surface.
  const counts = countByOutcome(entries);

  const visible =
    outcomeFilter && isActivityOutcome(outcomeFilter)
      ? entries.filter((e) => e.outcome === outcomeFilter)
      : entries;

  return NextResponse.json({
    entries: visible.slice(0, limit),
    counts,
    truncated: visible.length > limit,
  });
}

function first(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    return (value[0] as Record<string, unknown> | undefined) ?? null;
  }
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  return null;
}

/** "[title] — [details]", the same shape the inbox bubble shows. */
function messageError(message: Record<string, unknown> | null): string | null {
  if (!message) return null;
  const title = (message.error_title as string | null) ?? null;
  if (!title) return null;
  const details = (message.error_details as string | null) ?? null;
  return details ? `${title} — ${details}` : title;
}
