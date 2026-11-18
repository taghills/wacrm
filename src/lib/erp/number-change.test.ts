// ============================================================
// A corrected phone number.
//
// Staff type a wrong number, a message goes to a stranger, staff fix
// the number in the ERP. From then on nothing may go to the old
// number. Three ways it still could, or nearly did:
//
//  1. The event that carries the new number found the contact by its
//     ERP id BEFORE saving, so the contact in hand still had the old
//     number — and the message went there.
//  2. Another CRM contact already has the new number, the unique
//     index refused the save, the error was only logged, and every
//     later message kept going to the stranger.
//  3. Blocking that case instead (the first fix) held back messages
//     for families: several ERP customers share one number, so the
//     corrected number very often already has a contact. That contact
//     is the right one to message; the old one may be other
//     customers' real number and must be left alone.
// ============================================================

import { describe, expect, it } from 'vitest';

import { blockedNumberDetail, movedNumberNote, saveContactFields } from './process';

type Result = { error: { code?: string; message: string } | null };
type Row = { id: string; phone: string; marketing_opt_out?: boolean };

interface Update {
  fields: Record<string, unknown>;
  where: Record<string, unknown>;
}

/** A fake `db` that records every contacts update and answers phone lookups from `rows`. */
function ctxWith(results: Result[], rows: Row[] = []) {
  const updates: Update[] = [];
  const db = {
    from: (table: string) => {
      expect(table).toBe('contacts');
      return {
        update: (fields: Record<string, unknown>) => {
          const where: Record<string, unknown> = {};
          const result = results.shift() ?? { error: null };
          updates.push({ fields, where });
          const chain = {
            eq: (col: string, val: unknown) => {
              where[col] = val;
              return chain;
            },
            then: (ok: (r: Result) => unknown, bad?: (e: unknown) => unknown) =>
              Promise.resolve(result).then(ok, bad),
          };
          return chain;
        },
        // findExistingContact: .select('*').eq('account_id', …).like('phone', '%<last 8>')
        select: () => ({
          eq: () => ({
            like: async (_col: string, pattern: string) => ({
              data: rows.filter((r) => r.phone.endsWith(pattern.replace('%', ''))),
              error: null,
            }),
          }),
        }),
      };
    },
  };
  const ctx = {
    db,
    accountId: 'acc-1',
    currency: 'INR',
    reviewUrl: null,
    reviewDelayDays: 3,
    allowedBranches: [],
  } as unknown as Parameters<typeof saveContactFields>[0];
  return { ctx, updates };
}

// Made-up numbers: the repo is public.
const OLD = '911000000001';
const NEW = '911000000002';
const CONTACT = { id: 'contact-old', phone: OLD, marketingOptOut: false };
const UNIQUE = { error: { code: '23505', message: 'duplicate key value' } };

describe('saveContactFields — a corrected number', () => {
  it('saves the new number and says to send there, this same event', async () => {
    const { ctx, updates } = ctxWith([{ error: null }]);
    const out = await saveContactFields(ctx, CONTACT, {
      erpCustomerId: '42',
      name: 'Test Customer',
      phone: `+${NEW}`,
    });
    expect(out.phone).toBe(NEW);
    expect(out.contact).toEqual({ ...CONTACT, phone: NEW });
    expect(out.movedFrom).toBeNull();
    expect(out.phoneBlockedBy).toBeNull();
    expect(updates).toHaveLength(1);
    expect(updates[0].fields).toMatchObject({ phone: NEW, name: 'Test Customer', erp_customer_id: '42' });
  });

  it('keeps the stored number when the ERP sends the same one in another format', async () => {
    const { ctx, updates } = ctxWith([{ error: null }]);
    const out = await saveContactFields(ctx, { ...CONTACT, phone: `+${OLD}` }, {
      erpCustomerId: '42',
      phone: OLD,
    });
    expect(out.phone).toBe(`+${OLD}`);
    expect(out.contact.id).toBe(CONTACT.id);
    expect(updates[0].fields).not.toHaveProperty('phone');
  });

  it('moves to the contact that already has the new number (a shared family number)', async () => {
    const owner: Row = { id: 'contact-family', phone: NEW, marketing_opt_out: true };
    const { ctx, updates } = ctxWith([UNIQUE, { error: null }, { error: null }], [owner]);
    const out = await saveContactFields(ctx, CONTACT, {
      erpCustomerId: '42',
      name: 'Test Customer',
      phone: NEW,
    });

    // The event now belongs to the family contact — including its
    // marketing opt-out, which is that contact's own consent.
    expect(out).toMatchObject({
      contact: { id: 'contact-family', phone: NEW, marketingOptOut: true },
      movedFrom: 'contact-old',
      phone: NEW,
      phoneBlockedBy: null,
    });

    // 1: the refused save; 2: the old contact loses ONLY the ERP link,
    // and only if it is still this customer's; 3: the family contact
    // takes the link and the ERP's fields.
    expect(updates).toHaveLength(3);
    expect(updates[1].where).toMatchObject({ id: 'contact-old', erp_customer_id: '42' });
    expect(Object.keys(updates[1].fields).sort()).toEqual(['erp_customer_id', 'updated_at']);
    expect(updates[1].fields.erp_customer_id).toBeNull();
    expect(updates[2].where).toMatchObject({ id: 'contact-family' });
    expect(updates[2].fields).toMatchObject({ erp_customer_id: '42', name: 'Test Customer' });
    expect(updates[2].fields).not.toHaveProperty('phone');
  });

  it('never changes the old contact\'s number when moving', async () => {
    // The old number may be other customers' real number.
    const { ctx, updates } = ctxWith([UNIQUE], [{ id: 'contact-family', phone: NEW }]);
    await saveContactFields(ctx, CONTACT, { erpCustomerId: '42', phone: NEW });
    const touchesOld = updates.filter((u) => u.where.id === 'contact-old');
    for (const u of touchesOld.slice(1)) expect(u.fields).not.toHaveProperty('phone');
  });

  it('throws when the move fails half-way, so the ERP retries', async () => {
    const { ctx } = ctxWith(
      [UNIQUE, { error: null }, { error: { message: 'boom' } }],
      [{ id: 'contact-family', phone: NEW }],
    );
    await expect(
      saveContactFields(ctx, CONTACT, { erpCustomerId: '42', phone: NEW }),
    ).rejects.toThrow(/move the ERP link onto/);
  });

  it('blocks sending when the number is taken but its contact cannot be found', async () => {
    const { ctx, updates } = ctxWith([UNIQUE, { error: null }], []);
    const out = await saveContactFields(ctx, CONTACT, {
      erpCustomerId: '42',
      name: 'Test Customer',
      phone: NEW,
    });
    expect(out).toMatchObject({ contact: CONTACT, movedFrom: null, phone: OLD, phoneBlockedBy: NEW });
    expect(updates[1].fields).not.toHaveProperty('phone');
    expect(updates[1].fields).toMatchObject({ name: 'Test Customer' });
  });

  it('throws on any other error, so the ERP retries instead of messaging the old number', async () => {
    const { ctx } = ctxWith([{ error: { code: '57014', message: 'statement timeout' } }]);
    await expect(
      saveContactFields(ctx, CONTACT, { erpCustomerId: '42', phone: NEW }),
    ).rejects.toThrow(/new number/);
  });

  it('does not throw for an error when the number is unchanged', async () => {
    const { ctx } = ctxWith([{ error: { message: 'boom' } }]);
    const out = await saveContactFields(ctx, CONTACT, { erpCustomerId: '42', phone: OLD });
    expect(out).toMatchObject({ phone: OLD, phoneBlockedBy: null, movedFrom: null });
  });

  it('ignores an unusable number from the ERP', async () => {
    const { ctx, updates } = ctxWith([{ error: null }]);
    const out = await saveContactFields(ctx, CONTACT, { erpCustomerId: '42', phone: '12' });
    expect(out.phone).toBe(OLD);
    expect(updates[0].fields).not.toHaveProperty('phone');
  });
});

describe('ledger text', () => {
  it('a block names both numbers and what to do', () => {
    const d = blockedNumberDetail(OLD, NEW);
    expect(d.startsWith('not sent:')).toBe(true);
    expect(d).toContain(OLD);
    expect(d).toContain(NEW);
    expect(d).toMatch(/resend from the ERP/);
  });

  it('a move names the new number and says the old contact was left alone', () => {
    const d = movedNumberNote(NEW);
    expect(d).toContain(NEW);
    expect(d).toMatch(/left unchanged/);
  });
});
