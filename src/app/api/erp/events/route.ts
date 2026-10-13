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
//   200 {"results":[...]}      — every event's outcome, in order
//   200 {"failed":["1042"], "results":[...]}
//                              — the ids in `failed` are retried
//   4xx / 5xx                  — the WHOLE batch is retried, 8 times
//                                with backoff, then given up on
//
// `failed` is unchanged and still drives the ERP's retries. `results`
// is additive, and exists because a 200 used to mean "processed",
// which the ERP reasonably read as "sent". An event the CRM
// deliberately SKIPPED — branch held back by the rollout gate, store
// with no phone number, branch matching no CRM store, template not
// approved — came back indistinguishable from a message that reached
// the customer. Staff saw "sent" against a bill nobody was ever told
// about. Each entry now carries `sent` / `skipped` / `failed` and,
// always, the reason in words a person can act on.
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
  reportFor,
  reportForSettled,
  type ErpEventReport,
} from '@/lib/erp/event-report';
import { resolveMessageSettings } from '@/lib/erp/message-settings';
import { parseAllowedBranches } from '@/lib/erp/send-gate';
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

  const settings = await resolveMessageSettings(db, accountId);

  const ctx: ErpProcessContext = {
    db,
    accountId,
    currency: (account?.default_currency as string) || 'INR',
    // From Settings -> Messages, falling back to REVIEW_LINK_URL so
    // a deployment that set the old environment variable keeps
    // working without anyone opening Settings first.
    reviewUrl: settings.reviewUrl,
    reviewDelayDays: settings.reviewDelayDays,
    allowedBranches: parseAllowedBranches(process.env.ERP_SEND_ONLY_BRANCHES),
  };

  // ---- dedupe -------------------------------------------------
  // One round trip for the whole batch rather than one per event.
  // 'done' and 'skipped' are both final; only 'failed' rows are
  // open to a retry.
  const ids = events.map((e) => e.id);
  const { data: seen } = await db
    .from('erp_events')
    // `detail` too: a replayed event is answered from the ledger, and
    // an answer with no reason is the silence this endpoint is being
    // changed to stop.
    .select('event_id, status, detail')
    .eq('account_id', accountId)
    .in('event_id', ids.slice(0, MAX_EVENTS_PER_BATCH));
  const settled = new Map(
    (seen ?? [])
      .filter((row) => row.status !== 'failed')
      .map((row) => [
        row.event_id as string,
        {
          status: String(row.status),
          detail: (row.detail as string | null) ?? null,
        },
      ]),
  );

  // ---- process ------------------------------------------------
  // Sequential on purpose. Two events for the same customer in one
  // batch (an order created and then paid) must resolve to the same
  // contact, and running them in parallel would race the
  // find-or-create into creating two.
  const failed: string[] = [];
  // One entry per event in the batch, in the order they arrived. The
  // ERP shows `skipped: <reason>` to shop staff instead of "sent",
  // which is the whole point: a held-back branch or a store with no
  // phone number used to be indistinguishable from a delivered
  // message.
  const results: ErpEventReport[] = [];
  for (const event of events) {
    const already = settled.get(event.id);
    if (already) {
      results.push(reportForSettled(event.id, already.status, already.detail));
      continue;
    }

    let outcome: ErpEventOutcome;
    try {
      outcome = await processErpEvent(ctx, event);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error('[erp/events] event failed', { id: event.id, type: event.type, detail });
      outcome = { status: 'failed', detail };
      failed.push(event.id);
    }

    results.push(reportFor(event.id, outcome));

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
        // Both for the Message activity screen: the branch is what
        // its filter reads (a contact can belong to several stores,
        // so the order's own branch is the only honest answer), and
        // the message id is its join to what Meta did afterwards.
        branch: outcome.branch ?? null,
        order_ref: outcome.orderRef ?? null,
        message_id: outcome.messageId ?? null,
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

  // `failed` keeps its exact shape and meaning — the ERP retries on
  // it and that contract is not ours to change under them. `results`
  // is additive: an ERP that has not been updated yet ignores it.
  return NextResponse.json(
    failed.length > 0 ? { failed, results } : { results },
  );
}
