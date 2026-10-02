// ============================================================
// POST /api/erp/events — the TAGHills ERP's inbound webhook.
//
// Authentication is two independent checks, both required:
//
//   Authorization: Bearer <ERP_API_KEY>        — who is calling
//   X-ERP-Signature: sha256=<hex>              — what they said
//
// The signature is computed over the RAW body, before any JSON
// parsing. Verifying a re-serialised object instead would compare a
// signature against bytes the sender never signed (key order, number
// formatting and whitespace all shift), so this route reads
// `request.text()` once and parses that same string.
//
// Response contract (set by the ERP's retry logic):
//   200 {}                     — all events accepted
//   200 {"failed":["1042"]}    — those ids are retried by the ERP
//   4xx / 5xx                  — the WHOLE batch is retried, 8 times
//                                with backoff, then given up on
//
// So a per-event problem must never become a non-2xx: one bad
// customer record would otherwise make the ERP re-send 99 good
// events, and every one of those would be a duplicate WhatsApp
// message if the ledger were not there to stop it.
// ============================================================

import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { verifyBearer, verifyEventSignature } from '@/lib/erp/signature';
import { parseEventBatch, MAX_EVENTS_PER_BATCH } from '@/lib/erp/events';
import {
  processErpEvent,
  resolveErpAccountId,
  type ErpEventOutcome,
  type ErpProcessContext,
} from '@/lib/erp/process';

// Sends are sequential and Meta is not instant; a full 100-event
// batch needs room. The ERP's own timeout is longer than this.
export const maxDuration = 300;

/** Unauthorized, with no hint about which of the two checks failed. */
function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

export async function POST(request: Request) {
  // ---- authenticate ------------------------------------------
  // Read the body first: both checks need it, and a request that
  // fails auth is cheap to reject afterwards.
  const rawBody = await request.text();

  if (!verifyBearer(request.headers.get('authorization'), process.env.ERP_API_KEY)) {
    return unauthorized();
  }
  if (
    !verifyEventSignature(
      rawBody,
      request.headers.get('x-erp-signature'),
      process.env.ERP_SHARED_SECRET,
    )
  ) {
    return unauthorized();
  }

  // ---- parse --------------------------------------------------
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Body is not valid JSON' }, { status: 400 });
  }

  const events = parseEventBatch(parsed);
  if (events === null) {
    return NextResponse.json(
      { error: 'Body must be { events: [...] }' },
      { status: 400 },
    );
  }
  if (events.length === 0) {
    return NextResponse.json({});
  }

  // ---- context ------------------------------------------------
  const db = supabaseAdmin();
  const resolved = await resolveErpAccountId(db, process.env.ERP_ACCOUNT_ID);
  if ('error' in resolved) {
    // A misconfiguration on our side, not a bad request from the
    // ERP — 500 so the batch is retried once we fix it rather than
    // silently dropped.
    console.error('[erp/events] cannot resolve account:', resolved.error);
    return NextResponse.json({ error: resolved.error }, { status: 500 });
  }
  const { accountId } = resolved;

  const { data: account } = await db
    .from('accounts')
    .select('default_currency')
    .eq('id', accountId)
    .maybeSingle();

  const ctx: ErpProcessContext = {
    db,
    accountId,
    currency: (account?.default_currency as string) || 'INR',
    reviewUrl: process.env.REVIEW_LINK_URL?.trim() || null,
  };

  // ---- dedupe -------------------------------------------------
  // One round trip for the whole batch rather than one per event.
  // 'done' and 'skipped' are both final; only 'failed' rows are
  // open to a retry.
  const ids = events.map((e) => e.id);
  const { data: seen } = await db
    .from('erp_events')
    .select('event_id, status')
    .eq('account_id', accountId)
    .in('event_id', ids.slice(0, MAX_EVENTS_PER_BATCH));
  const settled = new Set(
    (seen ?? [])
      .filter((row) => row.status !== 'failed')
      .map((row) => row.event_id as string),
  );

  // ---- process ------------------------------------------------
  // Sequential on purpose. Two events for the same customer in one
  // batch (an order created and then paid) must resolve to the same
  // contact, and running them in parallel would race the
  // find-or-create into creating two.
  const failed: string[] = [];
  for (const event of events) {
    if (settled.has(event.id)) continue;

    let outcome: ErpEventOutcome;
    try {
      outcome = await processErpEvent(ctx, event);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error('[erp/events] event failed', { id: event.id, type: event.type, detail });
      outcome = { status: 'failed', detail };
      failed.push(event.id);
    }

    // Record before moving on. If the function dies mid-batch, the
    // events already handled stay handled and the ERP's retry only
    // redoes the rest.
    const { error: ledgerError } = await db.from('erp_events').upsert(
      {
        account_id: accountId,
        event_id: event.id,
        event_type: event.type,
        status: outcome.status,
        detail: outcome.detail?.slice(0, 500) ?? null,
        contact_id: outcome.contactId ?? null,
        received_at: new Date().toISOString(),
      },
      { onConflict: 'account_id,event_id' },
    );
    if (ledgerError) {
      // The work is done but we cannot prove it. Telling the ERP
      // this event failed would guarantee a duplicate message on
      // retry, so log loudly and report success — at-most-once
      // delivery matters more here than a perfect ledger.
      console.error('[erp/events] ledger write failed', {
        id: event.id,
        error: ledgerError.message,
      });
    }
  }

  return NextResponse.json(failed.length > 0 ? { failed } : {});
}
