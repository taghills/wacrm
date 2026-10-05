import { describe, it, expect } from "vitest";

import { linkContactToStoreFromBot, SetStoreError } from "./set-store";

/**
 * Minimal Supabase stub: records the upsert it was given and answers
 * the store lookup with whatever the test supplies.
 */
function makeDb(opts: {
  store?: { id: string } | null;
  storeError?: { message: string } | null;
  upsertError?: { message: string } | null;
}) {
  const calls: { table: string; payload?: unknown; options?: unknown }[] = [];
  const filters: Record<string, unknown> = {};

  const db = {
    from(table: string) {
      calls.push({ table });
      if (table === "stores") {
        const chain = {
          select: () => chain,
          eq: (col: string, val: unknown) => {
            filters[col] = val;
            return chain;
          },
          maybeSingle: async () => ({
            data: opts.store ?? null,
            error: opts.storeError ?? null,
          }),
        };
        return chain;
      }
      return {
        upsert: async (payload: unknown, options: unknown) => {
          calls.push({ table, payload, options });
          return { error: opts.upsertError ?? null };
        },
      };
    },
  };

  return { db: db as never, calls, filters };
}

const input = {
  accountId: "acc-1",
  contactId: "contact-1",
  storeId: "store-1",
};

describe("linkContactToStoreFromBot", () => {
  it("writes the link with source 'bot'", async () => {
    const { db, calls } = makeDb({ store: { id: "store-1" } });
    await linkContactToStoreFromBot(db, input);

    const upsert = calls.find((c) => c.table === "contact_stores" && c.payload !== undefined);
    expect(upsert?.payload).toEqual({
      contact_id: "contact-1",
      store_id: "store-1",
      account_id: "acc-1",
      source: "bot",
    });
  });

  it("never overwrites an existing link", async () => {
    // The ERP's 'erp' links come from real sales orders. A customer
    // later tapping a menu must not downgrade one to 'bot'.
    const { db, calls } = makeDb({ store: { id: "store-1" } });
    await linkContactToStoreFromBot(db, input);

    const upsert = calls.find((c) => c.table === "contact_stores" && c.payload !== undefined);
    expect(upsert?.options).toEqual({
      onConflict: "contact_id,store_id",
      ignoreDuplicates: true,
    });
  });

  it("scopes the store lookup to the account and to active stores", async () => {
    // Node configs are JSONB and flows can be cloned, so the stored
    // store_id is not trusted — this is the check that stops a flow
    // naming a store in another account.
    const { db, filters } = makeDb({ store: { id: "store-1" } });
    await linkContactToStoreFromBot(db, input);

    expect(filters).toEqual({
      id: "store-1",
      account_id: "acc-1",
      active: true,
    });
  });

  it("refuses a store that is unknown, inactive, or another account's", async () => {
    const { db, calls } = makeDb({ store: null });
    await expect(linkContactToStoreFromBot(db, input)).rejects.toBeInstanceOf(
      SetStoreError,
    );
    // And writes nothing.
    expect(calls.find((c) => c.table === "contact_stores" && c.payload !== undefined)).toBeUndefined();
  });

  it("refuses when the lookup itself fails, rather than writing blind", async () => {
    const { db, calls } = makeDb({
      store: null,
      storeError: { message: "boom" },
    });
    await expect(linkContactToStoreFromBot(db, input)).rejects.toBeInstanceOf(
      SetStoreError,
    );
    expect(calls.find((c) => c.table === "contact_stores" && c.payload !== undefined)).toBeUndefined();
  });

  it("surfaces a failed write", async () => {
    const { db } = makeDb({
      store: { id: "store-1" },
      upsertError: { message: "denied" },
    });
    await expect(linkContactToStoreFromBot(db, input)).rejects.toThrow(/denied/);
  });

  it("refuses a run with no contact or no store configured", async () => {
    const { db } = makeDb({ store: { id: "store-1" } });
    await expect(
      linkContactToStoreFromBot(db, { ...input, contactId: "" }),
    ).rejects.toBeInstanceOf(SetStoreError);
    await expect(
      linkContactToStoreFromBot(db, { ...input, storeId: "" }),
    ).rejects.toBeInstanceOf(SetStoreError);
  });
});
