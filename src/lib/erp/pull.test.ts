import { describe, expect, it } from 'vitest';
import { hmacHex } from './signature';
import { pullConfig, pullOnce, pullTick, DEFAULT_ERP_BASE_URL, type PullConfig } from './pull';

const cfg: PullConfig = { baseUrl: 'https://erp.example', apiKey: 'k', secret: 's' };
const sig = (body: string) => `sha256=${hmacHex(body, 's')}`;

/** A fake ERP: answers /api/crm/pull from a queue of batches and records every request. */
function fakeErp(batches: (null | { body: string; signature?: string; ids: string[] })[], pullStatus = 200) {
  const calls: { path: string; body: Record<string, unknown>; auth: string | null; sigOk: boolean }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const raw = String(init.body);
    const headers = new Headers(init.headers);
    calls.push({ path, body: JSON.parse(raw), auth: headers.get('authorization'), sigOk: headers.get('x-erp-signature') === sig(raw) });
    if (path === '/api/crm/pull') {
      if (pullStatus !== 200) return new Response('blocked', { status: pullStatus });
      const b = batches.shift() ?? null;
      return Response.json({ batch: b && { ...b, signature: b.signature ?? sig(b.body) } });
    }
    return Response.json({ ok: true });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

describe('pullConfig', () => {
  it('is off without the ERP credentials, or with ERP_PULL=off', () => {
    expect(pullConfig({})).toBeNull();
    expect(pullConfig({ ERP_API_KEY: 'k', ERP_SHARED_SECRET: 's', ERP_PULL: 'off' })).toBeNull();
  });
  it('defaults to the TAGHills ERP and honours ERP_BASE_URL', () => {
    expect(pullConfig({ ERP_API_KEY: 'k', ERP_SHARED_SECRET: 's' })?.baseUrl).toBe(DEFAULT_ERP_BASE_URL);
    expect(pullConfig({ ERP_API_KEY: 'k', ERP_SHARED_SECRET: 's', ERP_BASE_URL: 'https://erp.example/' })?.baseUrl).toBe('https://erp.example');
  });
});

describe('pullOnce', () => {
  it('runs a signed batch through the normal handler and reports the answer back', async () => {
    const body = JSON.stringify({ source: 'taghills-erp', events: [{ id: '7', type: 'order.created' }] });
    const { calls, fetchFn } = fakeErp([{ body, ids: ['7'] }]);
    const handled: string[] = [];
    const r = await pullOnce(cfg, {
      fetch: fetchFn,
      handle: async (raw, signature, apiKey) => {
        handled.push(raw);
        expect(signature).toBe(sig(raw));
        expect(apiKey).toBe('k');
        return { status: 200, json: { results: [{ eventId: '7', status: 'sent', reason: 'sent' }] } };
      },
    });
    expect(r).toEqual({ kind: 'processed', count: 1, status: 200 });
    expect(handled).toEqual([body]);
    expect(calls.map((c) => c.path)).toEqual(['/api/crm/pull', '/api/crm/pull/ack']);
    expect(calls.every((c) => c.auth === 'Bearer k' && c.sigOk)).toBe(true);
    expect(calls[1].body).toEqual({ ids: ['7'], status: 200, response: { results: [{ eventId: '7', status: 'sent', reason: 'sent' }] } });
  });

  it('does nothing when nothing is waiting', async () => {
    const { calls, fetchFn } = fakeErp([null]);
    const r = await pullOnce(cfg, { fetch: fetchFn, handle: async () => { throw new Error('must not run'); } });
    expect(r).toEqual({ kind: 'empty' });
    expect(calls).toHaveLength(1);
  });

  it('never processes a batch the ERP did not sign, but still releases it', async () => {
    const { calls, fetchFn } = fakeErp([{ body: '{"events":[]}', signature: 'sha256=forged', ids: ['9'] }]);
    let ran = false;
    const r = await pullOnce(cfg, { fetch: fetchFn, handle: async () => { ran = true; return { status: 200, json: {} }; } });
    expect(ran).toBe(false);
    expect(r.kind).toBe('error');
    expect(calls[1]).toMatchObject({ path: '/api/crm/pull/ack', body: { ids: ['9'], status: 401 } });
  });

  it('reports a handler crash as a 500, so the ERP keeps the events for a retry', async () => {
    const { calls, fetchFn } = fakeErp([{ body: '{"events":[]}', ids: ['3'] }]);
    await pullOnce(cfg, { fetch: fetchFn, handle: async () => { throw new Error('db down'); } });
    expect(calls[1].body).toEqual({ ids: ['3'], status: 500, response: { error: 'db down' } });
  });
});

describe('pullTick', () => {
  it('keeps collecting while batches come back full, then stops', async () => {
    const full = { body: '{"events":[]}', ids: Array.from({ length: 100 }, (_, i) => String(i)) };
    const { calls, fetchFn } = fakeErp([full, full, { body: '{"events":[]}', ids: ['x'] }, full]);
    await pullTick(cfg, { fetch: fetchFn, handle: async () => ({ status: 200, json: {} }), log: () => {} });
    expect(calls.filter((c) => c.path === '/api/crm/pull')).toHaveLength(3);
  });

  it('stops quietly when the ERP refuses', async () => {
    const logs: string[] = [];
    const { calls, fetchFn } = fakeErp([], 401);
    await pullTick(cfg, { fetch: fetchFn, handle: async () => ({ status: 200, json: {} }), log: (m) => logs.push(m) });
    expect(calls).toHaveLength(1);
    expect(logs[0]).toMatch(/HTTP 401/);
  });
});
