// ============================================================
// POST /api/erp/inbox-counts — "how many customers are waiting?"
//
// The ERP shows this on each till beside the chat link it already
// has. Authentication is the same two checks as /api/erp/events,
// over the same raw body:
//
//   Authorization: Bearer <ERP_API_KEY>
//   X-ERP-Signature: sha256=<hex over the RAW body>
//
// Request:   { "branch": "Shastri Nagar" }   one branch
//            { "branch": null } / {} / —     the whole account
//
// Response:  { "unread": 3, "awaitingReply": 5 }
//
//   unread        conversations with an unopened incoming message
//   awaitingReply conversations whose LAST message is the customer's,
//                 unless that message is only "ok" / "thanks" / 👍
//
// The second is the useful one. A thread staff have opened and not
// answered is no longer bold in the inbox, so it is the one that
// gets forgotten; `awaitingReply` counts it and `unread` does not.
//
// A branch that matches no store is a 400 naming the branch and
// listing the stores we do have — not a 200 with zeros. A till
// showing "0 waiting" because its name is spelled differently in
// two systems is the exact failure this integration has already
// had once, with order messages.
// ============================================================

import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { verifyBearer, verifyEventSignature } from '@/lib/erp/signature';
import { countAwaitingReply, parseInboxCountsBody, readInboxCounts } from '@/lib/erp/inbox-counts';
import { matchStoreByBranch, resolveErpAccountId } from '@/lib/erp/process';

/** Unauthorized, with no hint about which of the two checks failed. */
function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

export async function POST(request: Request) {
  // ---- authenticate ------------------------------------------
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
  // An empty body is allowed and means the whole account; it still
  // has to be signed, and '' is what was signed.
  let parsed: unknown = null;
  if (rawBody.trim().length > 0) {
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: 'Body is not valid JSON' }, { status: 400 });
    }
  }

  const body = parseInboxCountsBody(parsed);
  if (!body) {
    return NextResponse.json(
      { error: 'Body must be { "branch": "<store name>" } or { "branch": null }' },
      { status: 400 },
    );
  }

  // ---- context ------------------------------------------------
  const db = supabaseAdmin();
  const resolved = await resolveErpAccountId(db, process.env.ERP_ACCOUNT_ID);
  if ('error' in resolved) {
    console.error('[erp/inbox-counts] cannot resolve account:', resolved.error);
    return NextResponse.json({ error: resolved.error }, { status: 500 });
  }
  const { accountId } = resolved;

  // ---- branch -> store ----------------------------------------
  let storeId: string | null = null;
  if (body.branch) {
    const { data: stores, error: storeError } = await db
      .from('stores')
      .select('id, name, code')
      .eq('account_id', accountId)
      .eq('active', true);

    if (storeError) {
      console.error('[erp/inbox-counts] store lookup failed:', storeError);
      return NextResponse.json({ error: 'Could not read the store list' }, { status: 500 });
    }

    const match = matchStoreByBranch(stores ?? [], body.branch);
    if (!match) {
      return NextResponse.json(
        {
          error: `No active store matches branch "${body.branch}"`,
          // What we DO have, so the mismatch is fixable from this
          // response alone instead of over two more messages.
          stores: (stores ?? []).map((s) => s.name),
        },
        { status: 400 },
      );
    }
    storeId = match.id as string;
  }

  // ---- count --------------------------------------------------
  const { data, error } = await db.rpc('erp_inbox_counts', {
    p_account_id: accountId,
    p_store_id: storeId,
  });

  if (error) {
    // Most likely cause by far: migration 057 has not been applied
    // to this database yet. Say so rather than returning zeros.
    console.error('[erp/inbox-counts] erp_inbox_counts failed:', error);
    return NextResponse.json(
      {
        error:
          'Counting failed. If this says the function does not exist, migration 057 has not been applied.',
      },
      { status: 500 },
    );
  }

  const counts = readInboxCounts(data);

  // ---- leave out "ok" / "thanks" ------------------------------
  // Without migration 058 the function is missing: keep 057's count
  // (every waiting thread, acknowledgements included) and say so in
  // the log, rather than failing a badge that worked yesterday.
  const { data: waiting, error: waitingError } = await db.rpc('erp_inbox_waiting', {
    p_account_id: accountId,
    p_store_id: storeId,
  });
  if (waitingError) {
    console.warn(
      '[erp/inbox-counts] erp_inbox_waiting failed (migration 058 applied?); "ok"/"thanks" threads are still counted as waiting:',
      waitingError.message,
    );
  } else {
    counts.awaitingReply = countAwaitingReply(waiting);
  }

  return NextResponse.json(counts);
}
