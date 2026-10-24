import { describe, expect, it } from 'vitest';
import {
  fetchContactsByIds,
  fetchContactsByPhoneKeys,
  ID_CHUNK,
  PHONE_CHUNK,
} from './use-broadcast-sending';

/** A fake Supabase client that records every `.in()` list and answers with one row per value. */
function fakeSupabase(fail?: string) {
  const calls: { column: string; values: string[]; account?: string }[] = [];
  const client = {
    from: () => {
      let account: string | undefined;
      const q = {
        select: () => q,
        eq: (_col: string, v: string) => { account = v; return q; },
        in: async (column: string, values: string[]) => {
          calls.push({ column, values, account });
          if (fail) return { data: null, error: { message: fail } };
          return { data: values.map((v) => ({ id: v, phone: v })), error: null };
        },
      };
      return q;
    },
  };
  return { client: client as never, calls };
}

const numbers = (n: number) => Array.from({ length: n }, (_, i) => `9198${String(i).padStart(8, '0')}`);

describe('CSV contact lookup', () => {
  it('looks up a big list in small pages (a single ~1,800-number lookup failed with "Bad Request")', async () => {
    const { client, calls } = fakeSupabase();
    const keys = numbers(1758);
    const found = await fetchContactsByPhoneKeys(client, 'acc-1', keys);
    expect(found).toHaveLength(1758);
    expect(calls).toHaveLength(Math.ceil(1758 / PHONE_CHUNK));
    expect(Math.max(...calls.map((c) => c.values.length))).toBeLessThanOrEqual(PHONE_CHUNK);
    expect(calls.every((c) => c.column === 'phone_normalized' && c.account === 'acc-1')).toBe(true);
    expect(calls.flatMap((c) => c.values)).toEqual(keys);
  });

  it('a small list is still a single lookup', async () => {
    const { client, calls } = fakeSupabase();
    await fetchContactsByPhoneKeys(client, 'acc-1', numbers(50));
    expect(calls).toHaveLength(1);
  });

  it('reports a failed lookup instead of carrying on', async () => {
    const { client } = fakeSupabase('Bad Request');
    await expect(fetchContactsByPhoneKeys(client, 'acc-1', numbers(10))).rejects.toThrow(
      'Failed to look up CSV contacts: Bad Request',
    );
  });
});

describe('contacts by id', () => {
  it('fetches thousands of ids in pages', async () => {
    const { client, calls } = fakeSupabase();
    const ids = numbers(2183);
    const found = await fetchContactsByIds(client, ids);
    expect(found).toHaveLength(2183);
    expect(calls).toHaveLength(Math.ceil(2183 / ID_CHUNK));
    expect(calls.every((c) => c.column === 'id' && c.values.length <= ID_CHUNK)).toBe(true);
  });
});
