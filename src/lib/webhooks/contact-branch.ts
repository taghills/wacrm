// ============================================================
// Which store a webhook message belongs to — pure, no I/O.
//
// A receiver alerting "a customer wrote to you" has to pick the shop
// to alert. Without this it can only guess from its own records (the
// ERP uses the customer's latest bill), which sends the alert to the
// wrong shop when that bill was elsewhere.
//
// Named only when there is exactly ONE active store: a customer
// linked to two shops gives no honest answer, and a confident wrong
// one rings the wrong till. `null` lets the receiver fall back to
// its own rule.
// ============================================================

interface StoreRef {
  name?: unknown;
  active?: unknown;
}

/** One `contact_stores` row with its embedded `stores(name, active)`. */
export interface ContactStoreRow {
  stores?: StoreRef | StoreRef[] | null;
}

/** The single active store a contact is linked to, or null. */
export function contactBranchName(rows: ContactStoreRow[] | null | undefined): string | null {
  const names = new Set<string>();
  for (const row of rows ?? []) {
    // PostgREST embeds a to-one relation as an object, but typings
    // (and older clients) can hand back an array — accept both.
    const embedded = Array.isArray(row?.stores) ? row.stores : [row?.stores];
    for (const store of embedded) {
      if (!store || store.active === false) continue;
      const name = typeof store.name === 'string' ? store.name.trim() : '';
      if (name) names.add(name);
    }
  }
  return names.size === 1 ? [...names][0] : null;
}
