// ============================================================
// GET /api/erp/review/cron — send the review requests that are due.
//
// `order.delivered` queues a row in `erp_review_queue` due a few
// days out (Settings -> Messages). This drains it.
//
// Nothing in this app is scheduled, so an external scheduler has to
// call this — Hostinger's Cron Jobs, or any pinger — with the shared
// secret in `x-cron-secret`. It reuses AUTOMATION_CRON_SECRET rather
// than inventing a second one, so an operator who already schedules
// the automation and flow crons adds one URL, not one more secret.
// Returns 503 until that variable is set, like the other two.
//
// Once a day is enough: the delay is measured in days, so a row due
// today goes out whenever the run happens. Running it more often is
// harmless — a row is claimed before it is sent, so two overlapping
// runs cannot send twice.
// ============================================================

import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { templatePlanFor } from '@/lib/erp/events';
import { resolveMessageSettings } from '@/lib/erp/message-settings';
import {
  buildSendParams,
  linkContactToBranch,
  type ErpProcessContext,
} from '@/lib/erp/process';
import {
  dueReviewRequests,
  resolveReviewUrl,
  settleReviewRequest,
  type ReviewQueueRow,
} from '@/lib/erp/review-queue';
import { parseAllowedBranches, shouldSendForBranch } from '@/lib/erp/send-gate';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import { sendMessageToConversation } from '@/lib/whatsapp/send-message';

/**
 * Rows drained per run. Bounded so a backlog cannot run the request
 * past its timeout; the next run picks up the rest.
 */
const BATCH_LIMIT = 50;

export const maxDuration = 300;

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  }
  const supplied = request.headers.get('x-cron-secret') ?? '';
  const suppliedBuf = Buffer.from(supplied);
  const expectedBuf = Buffer.from(expected);
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = supabaseAdmin();
  const due = await dueReviewRequests(admin, BATCH_LIMIT);
  if (due.length === 0) {
    return NextResponse.json({ sent: 0, skipped: 0, failed: 0 });
  }

  // The gate is read once: it is a deployment-wide setting, and a
  // trial limited to one branch should hold back its review requests
  // too, not just its order messages.
  const allowedBranches = parseAllowedBranches(
    process.env.ERP_SEND_ONLY_BRANCHES,
  );

  // Settings are per account, and one drain can span accounts, so
  // they are cached per account rather than read per row.
  const settingsCache = new Map<string, Awaited<ReturnType<typeof resolveMessageSettings>>>();

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of due) {
    // Claim before sending. A row moved out of 'pending' by another
    // run returns nothing here, so two overlapping drains cannot
    // both send the same request. A row left in 'sending' means this
    // process died mid-send; it is not picked up again, because the
    // ask may already have reached the customer.
    const { data: claim } = await admin
      .from('erp_review_queue')
      .update({ status: 'sending', detail: null })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();
    if (!claim) continue;

    try {
      const outcome = await sendOneReview(admin, row, allowedBranches, settingsCache);
      await settleReviewRequest(admin, row.id, outcome.status, outcome.detail);
      if (outcome.status === 'sent') sent++;
      else skipped++;
    } catch (err) {
      // Left as 'failed' with the reason, so it shows on the status
      // page rather than vanishing. Not retried automatically: a
      // review request that is days late is better dropped than
      // sent at an odd time, and an admin can see why.
      const detail = err instanceof Error ? err.message : 'send failed';
      await settleReviewRequest(admin, row.id, 'failed', detail);
      failed++;
    }
  }

  return NextResponse.json({ sent, skipped, failed });
}

/**
 * Send one queued review request, or say why it was not sent.
 *
 * Mirrors the checks the live event path makes, because a queued
 * message is sent days later and anything could have changed in
 * between: the customer may have opted out, the branch may have been
 * removed from the send gate, the store may have lost its phone
 * number, the review link may have been cleared.
 */
async function sendOneReview(
  admin: ReturnType<typeof supabaseAdmin>,
  row: ReviewQueueRow,
  allowedBranches: string[],
  settingsCache: Map<string, Awaited<ReturnType<typeof resolveMessageSettings>>>,
): Promise<{ status: 'sent' | 'skipped'; detail: string }> {
  let settings = settingsCache.get(row.account_id);
  if (!settings) {
    settings = await resolveMessageSettings(admin, row.account_id);
    settingsCache.set(row.account_id, settings);
  }
  // The review link is NOT checked here. A store can carry its own,
  // so "is there a link" cannot be answered until the store is known
  // — checking the account-wide one first would skip a branch that
  // has its own listing while the account field sits empty.

  const gate = shouldSendForBranch(row.branch, allowedBranches);
  if (!gate.send) {
    return { status: 'skipped', detail: gate.reason ?? 'held back by the send gate' };
  }

  const { data: contact } = await admin
    .from('contacts')
    .select('id, name, phone, marketing_opt_out')
    .eq('id', row.contact_id)
    .maybeSingle();

  if (!contact?.phone) {
    return { status: 'skipped', detail: 'the contact has no phone number' };
  }
  // A review request is marketing, so STOP silences it. Checked here
  // and not only at delivery: the customer had days to opt out.
  if (contact.marketing_opt_out) {
    return { status: 'skipped', detail: 'contact opted out of marketing' };
  }

  // The branch's phone number, resolved the same way the live path
  // does it. linkContactToBranch is idempotent, so re-running it
  // costs nothing and keeps one source of truth for the matching.
  const ctx: ErpProcessContext = {
    db: admin,
    accountId: row.account_id,
    currency: 'INR',
    reviewUrl: settings.reviewUrl,
    reviewDelayDays: settings.reviewDelayDays,
    allowedBranches,
  };
  // NOTE: ctx.reviewUrl is the account-wide link, used only to resolve
  // the store below. The link that actually reaches the customer is
  // `reviewUrl`, chosen after the store is known.
  const link = row.branch
    ? await linkContactToBranch(ctx, contact.id as string, row.branch)
    : null;
  const branchPhone = link?.linked ? link.storePhone : null;

  // The branch's own Google listing wins over the account-wide link.
  // Reviews attach to a location, so a Bahadurgarh customer belongs
  // on Bahadurgarh's listing. The account link is the fallback, so
  // the branches' links can be collected one at a time without the
  // message breaking for the rest.
  const reviewUrl = resolveReviewUrl(
    link?.linked ? link.storeReviewUrl : null,
    settings.reviewUrl,
  );
  if (!reviewUrl) {
    return {
      status: 'skipped',
      detail: link?.linked
        ? `no review link for ${link.storeName}, and no account-wide link to fall back on`
        : 'no review link is configured',
    };
  }
  if (!branchPhone) {
    return {
      status: 'skipped',
      detail: link?.linked
        ? `store ${link.storeName} has no contact number: set it in Settings -> Stores`
        : `branch matched no store: ${row.branch ?? '(none)'}`,
    };
  }

  const plan = templatePlanFor(
    {
      id: `review:${row.erp_order_key}`,
      type: 'order.review',
      data: {
        billNo: row.erp_order_key,
        branch: row.branch,
        customer: { name: contact.name, phone: contact.phone },
      },
    },
    {
      reviewUrl,
      branchPhone,
    },
  );
  if (!plan) {
    return { status: 'skipped', detail: 'no review template could be built' };
  }

  const { conversationId } = await resolveConversationByPhone(
    admin,
    row.account_id,
    contact.phone as string,
    (contact.name as string | null) ?? null,
  );

  await sendMessageToConversation(admin, row.account_id, {
    conversationId,
    messageType: 'template',
    templateName: plan.templateName,
    templateParams: plan.params,
    // The button carries the store id; /r/<id> resolves it to this
    // branch's Google listing at tap time.
    templateMessageParams: buildSendParams(
      plan,
      link?.linked ? link.storeId : null,
    ),
  });

  return { status: 'sent', detail: `sent ${plan.templateName}` };
}
