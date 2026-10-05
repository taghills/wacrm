// ============================================================
// GET /api/erp/status — is the ERP integration actually working?
//
// Admin+ only. Open it in a signed-in browser tab.
//
// Why this exists
//
//   Every ERP event is recorded in `erp_events` with WHY it ended the
//   way it did — 'done', 'skipped' with a reason, or 'failed' with the
//   error. That is the one place which answers "the ERP says it sent
//   625 customers, so where are they?". Until this route it was
//   readable only by SQL, and an operator running this on managed
//   hosting may have no database access at all. A ledger nobody can
//   read is not a diagnostic.
//
//   It also answers the question behind most ERP mysteries in one
//   line: `accountMatches`. The ERP writes to the account resolved
//   from `ERP_ACCOUNT_ID`, or from whichever account has WhatsApp
//   connected. If that is not the account you are signed into, every
//   contact it creates is real and correctly stored — just in a
//   different tenant, invisible to you, with no error anywhere.
//
// Read-only. It changes nothing and never returns a secret: the
// bearer token and shared secret are reported as configured/not,
// never echoed.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { resolveErpAccountId } from '@/lib/erp/process';
import { supabaseAdmin } from '@/lib/flows/admin-client';

/** How many ledger rows to return. Newest first. */
const RECENT_LIMIT = 50;

export async function GET() {
  try {
    const ctx = await requireRole('admin');
    const admin = supabaseAdmin();

    const resolved = await resolveErpAccountId(admin, process.env.ERP_ACCOUNT_ID);
    const erpAccountId = 'error' in resolved ? null : resolved.accountId;

    // Ledger rows for the account the ERP actually writes to — not
    // the caller's. When those differ, showing the caller's own
    // (empty) ledger would hide the very problem this route exists
    // to surface.
    const ledgerAccountId = erpAccountId ?? ctx.accountId;

    const { data: recent, error: recentError } = await admin
      .from('erp_events')
      .select('event_id, event_type, status, detail, contact_id, received_at')
      .eq('account_id', ledgerAccountId)
      .order('received_at', { ascending: false })
      .limit(RECENT_LIMIT);

    const counts: Record<string, number> = {};
    for (const row of recent ?? []) {
      const key = `${row.event_type}:${row.status}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }

    // How many contacts the ERP has actually created, which is the
    // number the operator is really asking about.
    const { count: erpContacts } = await admin
      .from('contacts')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', ledgerAccountId)
      .not('erp_customer_id', 'is', null);

    return NextResponse.json({
      configured: {
        ERP_API_KEY: Boolean(process.env.ERP_API_KEY),
        ERP_SHARED_SECRET: Boolean(process.env.ERP_SHARED_SECRET),
        ERP_ACCOUNT_ID: Boolean(process.env.ERP_ACCOUNT_ID?.trim()),
        REVIEW_LINK_URL: Boolean(process.env.REVIEW_LINK_URL?.trim()),
      },
      account: {
        /** The account the ERP writes to. */
        erpAccountId,
        erpAccountError: 'error' in resolved ? resolved.error : null,
        /** The account you are signed into. */
        yourAccountId: ctx.accountId,
        /**
         * False means the ERP's contacts are landing in a different
         * tenant than the one you can see — and that ERP single
         * sign-on will refuse you for the same reason.
         */
        accountMatches: erpAccountId === ctx.accountId,
      },
      contacts: {
        fromErp: erpContacts ?? 0,
      },
      events: {
        /** Counts by "<event type>:<outcome>" across the rows below. */
        counts,
        recent: recent ?? [],
        readError: recentError?.message ?? null,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
