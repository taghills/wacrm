// ============================================================
// Acting on an ERP event: find the contact, keep its details in
// step with the ERP, link it to the branch that served it, and send
// the approved WhatsApp template the event calls for.
//
// Runs as the service role (there is no logged-in human on an ERP
// webhook), so every query is explicitly scoped by `accountId` —
// the same discipline the public API and the WhatsApp webhook
// follow. Nothing here reads `auth.uid()`.
//
// Ordering within one event:
//
//   1. resolve the contact (by ERP id, then by phone, else create)
//   2. mirror the ERP's fields onto it
//   3. link it to the branch's store, if the event names one
//   4. send the template, if the event maps to one
//
// Steps 1-3 run even when step 4 is skipped. A customer who has
// opted out of marketing still belongs in the CRM, still belongs to
// their store, and their staff still need to see them in the inbox.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { resolveImportTagIds } from '@/lib/contacts/resolve-import-tags';
import { addContactTagAndDispatch } from '@/lib/contacts/tag-events';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils';
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import { sendMessageToConversation } from '@/lib/whatsapp/send-message';
import {
  extractBranch,
  extractCustomer,
  isKnownEventType,
  isMarketingEvent,
  templatePlanFor,
  type ErpCustomer,
  type ErpEvent,
} from './events';
import { shouldSendForBranch } from './send-gate';

/** The tag every ERP-sourced contact carries, so they are filterable. */
export const ERP_CONTACT_TAG = 'erp-customer';

/** Custom attributes mirrored from the ERP onto the contact. */
const CUSTOM_FIELDS = {
  totalSpent: 'total_spent',
  lastPurchase: 'last_purchase',
  birthDate: 'birth_date',
  referralDiscount: 'referral_discount_percent',
} as const;

export interface ErpProcessContext {
  db: SupabaseClient;
  accountId: string;
  /** Account currency for money variables in templates. */
  currency: string;
  /** Where `thank_you_feedback` points. Null disables that one event. */
  reviewUrl: string | null;
  /**
   * Branches whose events may actually send a WhatsApp message,
   * already normalised. Empty = no gate, every branch sends.
   * See lib/erp/send-gate.ts.
   */
  allowedBranches: string[];
}

export type ErpEventStatus = 'done' | 'skipped' | 'failed';

export interface ErpEventOutcome {
  status: ErpEventStatus;
  detail?: string;
  contactId?: string;
}

/**
 * Prefix that marks a ledger detail as "the ERP named a branch no
 * CRM store answers to". `/api/erp/status` searches for this exact
 * string to list the branch names that are going unfiled, so it is a
 * wire format between the two files: change it in both or not at all.
 * The branch name follows the prefix verbatim.
 */
export const UNMATCHED_BRANCH = 'branch matched no store: ';

/** What `linkContactToBranch` did, and why, in words fit for the ledger. */
export type StoreLinkResult =
  | { linked: true; storeName: string; storeCode: string }
  | { linked: false; reason: string };

// ------------------------------------------------------------
// Account + config
// ------------------------------------------------------------

/**
 * Which account the ERP's events belong to.
 *
 * `ERP_ACCOUNT_ID` wins when set. Otherwise we resolve the single
 * account that has WhatsApp connected — a deployment serving exactly
 * one business (which this one is) should not need an extra env var
 * to state the obvious.
 *
 * Ambiguity is an error, never a guess: with two configured accounts
 * and no `ERP_ACCOUNT_ID`, picking one would silently file another
 * business's customers under the wrong tenant.
 */
export async function resolveErpAccountId(
  db: SupabaseClient,
  explicit: string | undefined,
): Promise<{ accountId: string } | { error: string }> {
  if (explicit && explicit.trim().length > 0) {
    const { data, error } = await db
      .from('accounts')
      .select('id')
      .eq('id', explicit.trim())
      .maybeSingle();
    if (error) return { error: 'Could not look up ERP_ACCOUNT_ID' };
    if (!data) return { error: 'ERP_ACCOUNT_ID does not match any account' };
    return { accountId: data.id as string };
  }

  const { data, error } = await db
    .from('whatsapp_config')
    .select('account_id')
    .limit(2);
  if (error) return { error: 'Could not resolve the ERP account' };
  if (!data || data.length === 0) {
    return { error: 'No account has WhatsApp configured yet' };
  }
  if (data.length > 1) {
    return {
      error:
        'More than one account has WhatsApp configured — set ERP_ACCOUNT_ID to say which one the ERP writes to',
    };
  }
  return { accountId: data[0].account_id as string };
}

// ------------------------------------------------------------
// Contacts
// ------------------------------------------------------------

interface ResolvedContact {
  id: string;
  phone: string;
  marketingOptOut: boolean;
}

/**
 * Find the CRM contact for an ERP customer, creating it if needed.
 *
 * Match order is `erpCustomerId` first, phone second — the ERP's id
 * is stable across a customer changing their number, while a phone
 * number can be reassigned by the telco to someone else entirely.
 * When an ERP id match is found we also take the opportunity to
 * update the stored phone, which is how a number change propagates.
 *
 * Returns null when there is nothing to match on and nothing valid
 * to create from (no usable phone) — the caller records that as a
 * skip, not a failure, per the handover: "If a customer has no valid
 * phone, skip and still return success for that event."
 */
export async function findOrCreateErpContact(
  ctx: ErpProcessContext,
  customer: ErpCustomer,
): Promise<ResolvedContact | null> {
  const { db, accountId } = ctx;
  const select = 'id, phone, marketing_opt_out';

  if (customer.erpCustomerId) {
    const { data } = await db
      .from('contacts')
      .select(select)
      .eq('account_id', accountId)
      .eq('erp_customer_id', customer.erpCustomerId)
      .maybeSingle();
    if (data) {
      return {
        id: data.id as string,
        phone: data.phone as string,
        marketingOptOut: Boolean(data.marketing_opt_out),
      };
    }
  }

  const phone = sanitizePhoneForMeta(customer.phone ?? '');
  if (!phone || !isValidE164(phone)) return null;

  const existing = await findExistingContact(db, accountId, phone);
  if (existing) {
    return {
      id: existing.id,
      phone: existing.phone,
      marketingOptOut: Boolean(
        (existing as Record<string, unknown>).marketing_opt_out,
      ),
    };
  }

  const auditUserId = await resolveAuditUserId(db, accountId);
  const { data: created, error } = await db
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: auditUserId,
      phone,
      name: customer.name || phone,
      email: customer.email ?? null,
      erp_customer_id: customer.erpCustomerId ?? null,
    })
    .select(select)
    .single();

  if (error || !created) {
    // Lost a race with an inbound WhatsApp message creating the same
    // contact. The unique index did its job; re-resolve the winner
    // rather than failing an event we can still handle.
    if (isUniqueViolation(error)) {
      const raced = await findExistingContact(db, accountId, phone);
      if (raced) {
        return {
          id: raced.id,
          phone: raced.phone,
          marketingOptOut: Boolean(
            (raced as Record<string, unknown>).marketing_opt_out,
          ),
        };
      }
    }
    throw new Error(`Failed to create contact: ${error?.message ?? 'unknown'}`);
  }

  return {
    id: created.id as string,
    phone: created.phone as string,
    marketingOptOut: Boolean(created.marketing_opt_out),
  };
}

/**
 * Mirror the ERP's view of a customer onto the CRM contact.
 *
 * Deliberately does NOT overwrite a name with an empty one, and
 * never touches `marketing_opt_out` — consent was given to this
 * channel and the ERP has no standing to revoke or restore it.
 */
export async function syncContactFromErp(
  ctx: ErpProcessContext,
  contactId: string,
  customer: ErpCustomer,
): Promise<void> {
  const { db, accountId } = ctx;

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (customer.name) patch.name = customer.name;
  if (customer.email) patch.email = customer.email;
  if (customer.erpCustomerId) patch.erp_customer_id = customer.erpCustomerId;
  if (customer.phone) {
    const phone = sanitizePhoneForMeta(customer.phone);
    if (phone && isValidE164(phone)) patch.phone = phone;
  }

  const { error } = await db
    .from('contacts')
    .update(patch)
    .eq('id', contactId)
    .eq('account_id', accountId);
  if (error) {
    // A phone collision here means two ERP customers share a number.
    // Keep the rest of the event working rather than failing it.
    console.warn('[erp] contact update skipped:', error.message);
  }

  await applyErpTag(ctx, contactId);
  await applyCustomValues(ctx, contactId, customer);
}

/** Tag the contact `erp-customer`, creating the tag on first use. */
async function applyErpTag(
  ctx: ErpProcessContext,
  contactId: string,
): Promise<void> {
  const { db, accountId } = ctx;
  try {
    const auditUserId = await resolveAuditUserId(db, accountId);
    const { tagIdByKey } = await resolveImportTagIds(db, {
      accountId,
      userId: auditUserId,
      tagNames: [ERP_CONTACT_TAG],
      canCreateTags: true,
    });
    const tagId = tagIdByKey.get(ERP_CONTACT_TAG);
    if (!tagId) return;
    await addContactTagAndDispatch({ db, accountId, contactId, tagId });
  } catch (err) {
    // A tag is a convenience, not the point of the event. Log and
    // carry on rather than making the ERP retry a delivered message.
    console.warn('[erp] tagging failed:', err);
  }
}

/**
 * Write the ERP's numeric/date attributes as contact custom values,
 * creating the custom field definitions on first use so the operator
 * does not have to pre-create four fields by hand.
 */
async function applyCustomValues(
  ctx: ErpProcessContext,
  contactId: string,
  customer: ErpCustomer,
): Promise<void> {
  const values: Array<[string, string]> = [];
  if (customer.totalSpent !== null && customer.totalSpent !== undefined) {
    values.push([CUSTOM_FIELDS.totalSpent, String(customer.totalSpent)]);
  }
  if (customer.lastPurchase) {
    values.push([CUSTOM_FIELDS.lastPurchase, customer.lastPurchase]);
  }
  if (customer.birthDate) {
    values.push([CUSTOM_FIELDS.birthDate, customer.birthDate]);
  }
  if (
    customer.pendingReferralDiscountPercent !== null &&
    customer.pendingReferralDiscountPercent !== undefined
  ) {
    values.push([
      CUSTOM_FIELDS.referralDiscount,
      String(customer.pendingReferralDiscountPercent),
    ]);
  }
  if (values.length === 0) return;

  try {
    for (const [fieldName, value] of values) {
      const fieldId = await findOrCreateCustomField(ctx, fieldName);
      if (!fieldId) continue;
      await ctx.db
        .from('contact_custom_values')
        .upsert(
          { contact_id: contactId, custom_field_id: fieldId, value },
          { onConflict: 'contact_id,custom_field_id' },
        );
    }
  } catch (err) {
    console.warn('[erp] custom values failed:', err);
  }
}

async function findOrCreateCustomField(
  ctx: ErpProcessContext,
  fieldName: string,
): Promise<string | null> {
  const { db, accountId } = ctx;
  const { data: existing } = await db
    .from('custom_fields')
    .select('id')
    .eq('account_id', accountId)
    .eq('field_name', fieldName)
    .maybeSingle();
  if (existing) return existing.id as string;

  const auditUserId = await resolveAuditUserId(db, accountId);
  const { data: created, error } = await db
    .from('custom_fields')
    .insert({
      account_id: accountId,
      user_id: auditUserId,
      field_name: fieldName,
      field_type: 'text',
    })
    .select('id')
    .single();
  if (error || !created) {
    // Another event in the same batch created it first.
    const { data: raced } = await db
      .from('custom_fields')
      .select('id')
      .eq('account_id', accountId)
      .eq('field_name', fieldName)
      .maybeSingle();
    return (raced?.id as string) ?? null;
  }
  return created.id as string;
}

// ------------------------------------------------------------
// Stores
// ------------------------------------------------------------

/**
 * Link the contact to the store that served this order.
 *
 * This is the whole reason the ERP integration matters for staff
 * isolation: `contact_stores` is the security boundary (migration
 * 043), and a sales order in the ERP is the trusted event that says
 * "this customer belongs to this branch" — hence `source = 'erp'`.
 *
 * The branch arrives as a display name ("Shastri Nagar"); we match it
 * against both the store name and the short code, case- and
 * space-insensitively, because the two systems were named by
 * different people at different times ("Shastri" vs "Shashtri").
 *
 * An unmatched branch never fails the event: the message still needs
 * to go out, and a contact with no store link is visible to
 * owner/admin, who can assign it by hand. But it is not silent
 * either — the reason comes back to the caller, which writes it into
 * the event ledger so `/api/erp/status` can show it. A branch that
 * quietly matches nothing is how a whole store's customers end up
 * unfiled with no error anywhere, so "logged to stderr" is not
 * enough: the operator cannot read stderr.
 */
export async function linkContactToBranch(
  ctx: ErpProcessContext,
  contactId: string,
  branch: string,
): Promise<StoreLinkResult> {
  const { db, accountId } = ctx;
  const { data: stores } = await db
    .from('stores')
    .select('id, name, code')
    .eq('account_id', accountId)
    .eq('active', true);
  if (!stores || stores.length === 0) {
    return { linked: false, reason: `${UNMATCHED_BRANCH}${branch} (no active stores)` };
  }

  const key = normalizeStoreKey(branch);
  const match = stores.find(
    (s) =>
      normalizeStoreKey(String(s.name)) === key ||
      normalizeStoreKey(String(s.code)) === key,
  );
  if (!match) {
    console.warn('[erp] no store matches branch', { branch, accountId });
    return { linked: false, reason: `${UNMATCHED_BRANCH}${branch}` };
  }

  const { error } = await db.from('contact_stores').upsert(
    {
      contact_id: contactId,
      store_id: match.id,
      account_id: accountId,
      source: 'erp',
    },
    { onConflict: 'contact_id,store_id' },
  );
  if (error) {
    console.warn('[erp] store link failed:', error.message);
    return {
      linked: false,
      reason: `store link failed for branch ${branch}: ${error.message}`,
    };
  }
  return { linked: true, storeName: String(match.name), storeCode: String(match.code) };
}

/** Lowercase, strip everything that is not a letter or a digit. */
export function normalizeStoreKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ------------------------------------------------------------
// One event, end to end
// ------------------------------------------------------------

export async function processErpEvent(
  ctx: ErpProcessContext,
  event: ErpEvent,
): Promise<ErpEventOutcome> {
  if (event.type === 'ping') {
    return { status: 'done', detail: 'ping' };
  }
  if (!isKnownEventType(event.type)) {
    return { status: 'skipped', detail: `unknown event type: ${event.type}` };
  }

  const customer = extractCustomer(event);
  if (!customer) {
    return { status: 'skipped', detail: 'event carries no customer' };
  }

  const contact = await findOrCreateErpContact(ctx, customer);
  if (!contact) {
    return { status: 'skipped', detail: 'customer has no valid phone number' };
  }

  await syncContactFromErp(ctx, contact.id, customer);

  const branch = extractBranch(event);
  // Every return below carries the filing outcome, because "the
  // message went out" and "the customer was filed to a store" are
  // two different things and only the ledger can tell the operator
  // the second one happened.
  const link = branch
    ? await linkContactToBranch(ctx, contact.id, branch)
    : null;
  const note = storeLinkNote(link);

  // `customer.upsert` is a data event: it keeps the CRM in step with
  // the ERP and deliberately sends nothing.
  if (event.type === 'customer.upsert') {
    return {
      status: 'done',
      detail: withNote('contact synced', note),
      contactId: contact.id,
    };
  }

  // The send gate. Deliberately AFTER the contact and the store
  // link: a held-back branch's customers still appear in the CRM,
  // still belong to their store, and their staff still see them.
  // Only the outgoing message is withheld, which is what makes a
  // one-branch trial a trial rather than a partial rollout.
  const gate = shouldSendForBranch(branch, ctx.allowedBranches);
  if (!gate.send) {
    return {
      status: 'skipped',
      detail: withNote(gate.reason, note),
      contactId: contact.id,
    };
  }

  if (isMarketingEvent(event.type) && contact.marketingOptOut) {
    return {
      status: 'skipped',
      detail: withNote('contact opted out of marketing', note),
      contactId: contact.id,
    };
  }

  const plan = templatePlanFor(event, {
    currency: ctx.currency,
    reviewUrl: ctx.reviewUrl,
  });
  if (!plan) {
    return {
      status: 'skipped',
      detail: withNote(
        event.type === 'order.delivered'
          ? 'REVIEW_LINK_URL is not set, so there is no review link to send'
          : 'no template mapped for this event',
        note,
      ),
      contactId: contact.id,
    };
  }

  const { conversationId } = await resolveConversationByPhone(
    ctx.db,
    ctx.accountId,
    contact.phone,
    customer.name ?? null,
  );

  await sendMessageToConversation(ctx.db, ctx.accountId, {
    conversationId,
    messageType: 'template',
    templateName: plan.templateName,
    templateParams: plan.params,
  });

  return {
    status: 'done',
    detail: withNote(`sent ${plan.templateName}`, note),
    contactId: contact.id,
  };
}

/**
 * Turn a filing outcome into the clause appended to the ledger
 * detail. `null` — the event named no branch at all — is deliberately
 * silent: most non-order events carry no branch and saying so on
 * every row would bury the rows that matter.
 */
export function storeLinkNote(link: StoreLinkResult | null): string | null {
  if (!link) return null;
  if (link.linked) return `filed to ${link.storeName}`;
  return link.reason;
}

/**
 * Join a detail and its filing note into one ledger line.
 *
 * `detail` is optional because the send gate's decision carries no
 * reason when it lets an event through; the note alone is still worth
 * recording in that case.
 */
export function withNote(
  detail: string | undefined,
  note: string | null,
): string | undefined {
  if (!note) return detail;
  return detail ? `${detail} | ${note}` : note;
}
