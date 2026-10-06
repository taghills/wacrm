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
import { maskEmail } from '@/lib/erp/mask-email';
import { resolveErpAccountId } from '@/lib/erp/process';
import { parseAllowedBranches } from '@/lib/erp/send-gate';
import { supabaseAdmin } from '@/lib/flows/admin-client';

/** How many ledger rows to return. Newest first. */
const RECENT_LIMIT = 50;

/**
 * How many contacts are linked to each store, and where those links
 * came from.
 *
 * This is the question the whole store-isolation feature turns on —
 * an unlinked contact is visible to owner and admin only, so if these
 * counts are zero then every branch's staff see an empty CRM. It
 * belongs here because the alternative is reading it off a card in
 * the contact UI, which conflates "no links exist" with "the card
 * failed to load", and those need different fixes.
 *
 * `source` is the useful split: 'erp' means a real sales order said
 * so, 'bot' a customer's own branch pick, 'manual' an admin by hand.
 */
async function storeLinkSummary(
  admin: ReturnType<typeof supabaseAdmin>,
  accountId: string,
): Promise<Record<string, unknown>> {
  const { data: stores } = await admin
    .from("stores")
    .select("id, name, code, active")
    .eq("account_id", accountId);

  const { count: total } = await admin
    .from("contact_stores")
    .select("contact_id", { count: "exact", head: true })
    .eq("account_id", accountId);

  const bySource: Record<string, number> = {};
  for (const source of ["erp", "bot", "manual"]) {
    const { count } = await admin
      .from("contact_stores")
      .select("contact_id", { count: "exact", head: true })
      .eq("account_id", accountId)
      .eq("source", source);
    bySource[source] = count ?? 0;
  }

  const perStore: Array<Record<string, unknown>> = [];
  for (const store of stores ?? []) {
    const { count } = await admin
      .from("contact_stores")
      .select("contact_id", { count: "exact", head: true })
      .eq("account_id", accountId)
      .eq("store_id", store.id);
    perStore.push({
      name: store.name,
      code: store.code,
      active: store.active,
      contacts: count ?? 0,
    });
  }

  return { total: total ?? 0, bySource, perStore };
}

/**
 * Tables counted per account in the inventory below.
 *
 * Enough to answer "which of these accounts is the real CRM?"
 * without reading a single row of anyone's data — every query is a
 * HEAD request for a count.
 */
const INVENTORY_TABLES = [
  'profiles',
  'contacts',
  'conversations',
  'messages',
  'stores',
  'whatsapp_config',
] as const;

/** Guard against a pathological account list; two is the expected case. */
const MAX_ACCOUNTS = 10;

async function accountInventory(
  admin: ReturnType<typeof supabaseAdmin>,
): Promise<Array<Record<string, unknown>>> {
  const { data: accounts } = await admin
    .from('accounts')
    .select('id, name, owner_user_id, created_at')
    .order('created_at', { ascending: true })
    .limit(MAX_ACCOUNTS);

  const rows: Array<Record<string, unknown>> = [];
  for (const account of accounts ?? []) {
    const counts: Record<string, number> = {};
    for (const table of INVENTORY_TABLES) {
      const { count } = await admin
        .from(table)
        .select('id', { count: 'exact', head: true })
        .eq('account_id', account.id);
      counts[table] = count ?? 0;
    }
    // Who is in it. Enough to recognise which login owns which
    // account when someone has signed up twice and cannot tell the
    // two apart — the case this was written for.
    const { data: members } = await admin
      .from('profiles')
      .select('email, full_name, account_role, created_at')
      .eq('account_id', account.id)
      .order('created_at', { ascending: true });

    rows.push({
      id: account.id,
      name: account.name,
      createdAt: account.created_at,
      counts,
      members: (members ?? []).map((m) => ({
        email: maskEmail(m.email as string | null),
        name: m.full_name,
        role: m.account_role,
        joinedAt: m.created_at,
      })),
    });
  }
  return rows;
}

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
        /**
         * Shown as the VALUE, not a boolean. The whole point of the
         * gate is knowing exactly which branches are live, and
         * "true" would not tell you that. An empty array means no
         * gate: every branch sends.
         */
        ERP_SEND_ONLY_BRANCHES: parseAllowedBranches(
          process.env.ERP_SEND_ONLY_BRANCHES,
        ),
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
      /**
       * Zero here means nobody is assigned to a branch, so every
       * store's staff see nothing — the single most important number
       * on this page once contacts are arriving.
       */
      storeLinks: await storeLinkSummary(admin, ledgerAccountId),
      /**
       * What is in each account. This exists because "the ERP wrote
       * to a different account" is only half an answer — the other
       * half is which account holds the real CRM, and that decides
       * whether the fix is to point the ERP elsewhere or to move the
       * WhatsApp connection. Counts only; no row contents.
       */
      accounts: await accountInventory(admin),
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
