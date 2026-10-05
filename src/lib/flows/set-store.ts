// ============================================================
// Linking a contact to a store from inside a Flow — the customer's
// own branch pick.
//
// `contact_stores` is the staff-isolation boundary (migration 043):
// which rows live here decides which staff can see the customer's
// chat at all. So this is a security write, not a convenience one,
// and it is deliberately narrow:
//
//   * The store must belong to the SAME account as the contact, and
//     be active. A flow is account-scoped, but flows can be cloned
//     and templated and node configs are JSONB, so the engine
//     re-checks rather than trusting the stored id.
//
//   * The link is ADDITIVE and idempotent. Re-running a flow, or a
//     customer tapping a second branch, adds a row; nothing is ever
//     removed here. A customer who deals with two branches belongs
//     to both, which is the documented behaviour.
//
//   * `source = 'bot'` records where the link came from, and an
//     existing row is left alone. That matters because the ERP's
//     'erp' links come from real sales orders and carry more weight
//     than a tap on a menu — a later bot pick must not quietly
//     downgrade one.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

export class SetStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetStoreError";
  }
}

export interface LinkContactToStoreInput {
  accountId: string;
  contactId: string;
  storeId: string;
}

/**
 * Link `contactId` to `storeId` with `source = 'bot'`.
 *
 * Throws `SetStoreError` when the store is unknown, inactive, or in
 * another account. The engine treats that as non-fatal (logs the run
 * event and advances) — an unassigned contact is the fail-closed
 * default, visible to owner and admin only, which is the right place
 * to land when we cannot establish where they belong.
 */
export async function linkContactToStoreFromBot(
  db: SupabaseClient,
  input: LinkContactToStoreInput,
): Promise<void> {
  const { accountId, contactId, storeId } = input;

  if (!contactId) throw new SetStoreError("Flow run has no contact");
  if (!storeId) throw new SetStoreError("Node has no store_id");

  const { data: store, error: storeError } = await db
    .from("stores")
    .select("id")
    .eq("id", storeId)
    .eq("account_id", accountId)
    .eq("active", true)
    .maybeSingle();

  if (storeError) {
    throw new SetStoreError(`Could not look up store: ${storeError.message}`);
  }
  if (!store) {
    throw new SetStoreError(
      "Store not found, inactive, or belongs to another account",
    );
  }

  // `ignoreDuplicates` so an existing row keeps its original source:
  // a contact already linked by the ERP (a real sales order) is not
  // rewritten to 'bot' because they later tapped a menu.
  const { error } = await db.from("contact_stores").upsert(
    {
      contact_id: contactId,
      store_id: storeId,
      account_id: accountId,
      source: "bot",
    },
    { onConflict: "contact_id,store_id", ignoreDuplicates: true },
  );

  if (error) {
    throw new SetStoreError(`Could not link contact to store: ${error.message}`);
  }
}
