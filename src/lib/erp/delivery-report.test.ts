import { beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { collectFailures, reportDeliveryFailures, resetReported } from './delivery-report';
import { undeliveredConversations } from '@/hooks/use-undelivered';

/** A fake Supabase client answering the one query collectFailures makes. */
function dbWith(rows: unknown[], error: { message: string } | null = null) {
  const calls: Record<string, unknown> = {};
  const chain = {
    select: (cols: string) => { calls.select = cols; return chain; },
    not: (col: string, op: string, v: null) => { calls.not = [col, op, v]; return chain; },
    eq: (col: string, v: string) => { calls.eq = [col, v]; return chain; },
    gte: (col: string, v: string) => { calls.gte = [col, v]; return chain; },
    limit: async (n: number) => { calls.limit = n; return { data: rows, error }; },
  };
  const db = { from: (t: string) => { calls.from = t; return chain; } } as unknown as SupabaseClient;
  return { db, calls };
}

const NOW = new Date('2026-11-20T12:00:00.000Z');
const failed = (id: string, code: number | null = 131026) => ({
  event_id: id,
  received_at: '2026-11-20T10:00:00.000Z',
  messages: { status: 'failed', error_code: code, error_title: 'Message undeliverable', error_details: 'Message Undeliverable.' },
});

describe('collectFailures', () => {
  it('reads failed messages of ERP events from the last seven days', async () => {
    const { db, calls } = dbWith([failed('101'), failed('102', null)]);
    const out = await collectFailures(db, NOW);
    expect(out).toEqual([
      { id: '101', code: 131026, title: 'Message undeliverable', details: 'Message Undeliverable.' },
      { id: '102', code: null, title: 'Message undeliverable', details: 'Message Undeliverable.' },
    ]);
    expect(calls.from).toBe('erp_events');
    expect(calls.eq).toEqual(['messages.status', 'failed']);
    expect(calls.gte).toEqual(['received_at', '2026-11-13T12:00:00.000Z']);
  });

  it('skips rows that are not failed or have no usable event id', async () => {
    const { db } = dbWith([
      { event_id: '5', messages: { status: 'delivered' } },
      { event_id: 'abc', messages: { status: 'failed' } },
      { event_id: '6', messages: [{ status: 'failed', error_code: '131049' }] },
    ]);
    expect((await collectFailures(db, NOW)).map((f) => [f.id, f.code])).toEqual([['6', 131049]]);
  });

  it('throws on a read error', async () => {
    const { db } = dbWith([], { message: 'boom' });
    await expect(collectFailures(db, NOW)).rejects.toThrow(/boom/);
  });
});

describe('reportDeliveryFailures', () => {
  beforeEach(() => resetReported());

  it('sends the failures and remembers the ones the ERP took', async () => {
    const { db } = dbWith([failed('101'), failed('102')]);
    const posts: unknown[] = [];
    const post = async (path: string, payload: unknown) => {
      posts.push([path, payload]);
      return { ok: true, status: 200, json: { ok: true, accepted: ['101', '102'] } };
    };
    expect(await reportDeliveryFailures(db, post, NOW)).toBe(2);
    expect(posts).toHaveLength(1);
    expect((posts[0] as [string, { reports: { id: string }[] }])[0]).toBe('/api/crm/pull/delivery');
    expect((posts[0] as [string, { reports: { id: string }[] }])[1].reports.map((r) => r.id)).toEqual(['101', '102']);

    // next tick: nothing new, nothing sent
    expect(await reportDeliveryFailures(db, post, NOW)).toBe(0);
    expect(posts).toHaveLength(1);
  });

  it('an ERP without the address yet (404) is not an error, and nothing is marked', async () => {
    const { db } = dbWith([failed('101')]);
    let n = 0;
    const post = async () => { n++; return { ok: false, status: 404, json: null }; };
    expect(await reportDeliveryFailures(db, post, NOW)).toBe(0);
    expect(await reportDeliveryFailures(db, post, NOW)).toBe(0);
    expect(n).toBe(2); // tried again on the next tick
  });

  it('another HTTP error is reported to the caller', async () => {
    const { db } = dbWith([failed('101')]);
    const post = async () => ({ ok: false, status: 500, json: null });
    await expect(reportDeliveryFailures(db, post, NOW)).rejects.toThrow(/HTTP 500/);
  });
});

describe('undeliveredConversations', () => {
  const convs = [
    { id: 'a', last_message_at: '2026-11-20T10:00:00.000Z' },
    { id: 'b', last_message_at: '2026-11-20T11:00:00.000Z' },
  ];

  it('marks a chat whose latest message failed', () => {
    const s = undeliveredConversations([{ conversation_id: 'a', created_at: '2026-11-20T10:00:00.000Z' }], convs);
    expect([...s]).toEqual(['a']);
  });

  it('a newer message after the failure clears the mark', () => {
    const s = undeliveredConversations([{ conversation_id: 'b', created_at: '2026-11-20T10:30:00.000Z' }], convs);
    expect(s.size).toBe(0);
  });

  it('ignores chats that are not in the list', () => {
    expect(undeliveredConversations([{ conversation_id: 'z', created_at: '2026-11-20T12:00:00.000Z' }], convs).size).toBe(0);
  });
});
