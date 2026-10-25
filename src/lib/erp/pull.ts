// ============================================================
// Pull mode for the TAGHills ERP integration.
//
// Normally the ERP POSTs event batches to /api/erp/events. This
// deployment's host has refused those pushes from the ERP's server
// three different ways (CDN bot check, LiteSpeed captcha, TCP resets
// of the ERP host's shared outgoing address), while requests in the
// other direction — this CRM calling the ERP — always get through.
//
// So the CRM also *collects*: every PULL_INTERVAL_MS it asks the ERP
// for waiting events (POST <erp>/api/crm/pull). The ERP answers with
// the exact signed batch it would have pushed, and leases those events
// for five minutes so no other worker gets them. That batch goes
// through the very same handler as a push — same Bearer + signature
// checks, same ledger, same dedupe, same templates — and the handler's
// answer is reported back (POST <erp>/api/crm/pull/ack), where the ERP
// records it exactly like a push response. While the CRM keeps
// collecting, the ERP stops pushing.
//
// Both requests to the ERP carry the same credentials as everything
// else between the two: `Authorization: Bearer <ERP_API_KEY>` and
// `X-ERP-Signature: sha256=<hmac of the raw body under ERP_SHARED_SECRET>`.
// A batch whose signature does not verify is dropped, not processed.
//
// Configuration (all optional):
//   ERP_PULL=off          switch collecting off
//   ERP_BASE_URL          the ERP's API origin (default below)
// It only runs when ERP_API_KEY and ERP_SHARED_SECRET are set, i.e.
// on a deployment that has the ERP integration configured at all.
// ============================================================

import { hmacHex, verifyEventSignature } from './signature';

export const DEFAULT_ERP_BASE_URL = 'https://taghills-backend.onrender.com';
export const PULL_INTERVAL_MS = 30_000;
/** A full batch means more may be waiting: ask again at once, up to this many times per tick. */
const MAX_BATCHES_PER_TICK = 10;
const BATCH_SIZE = 100;

export interface PullConfig {
  baseUrl: string;
  apiKey: string;
  secret: string;
}

/** The pull configuration, or null when collecting is off / the ERP integration is not configured. */
export function pullConfig(env: Record<string, string | undefined> = process.env): PullConfig | null {
  if ((env.ERP_PULL || '').trim().toLowerCase() === 'off') return null;
  const apiKey = env.ERP_API_KEY || '';
  const secret = env.ERP_SHARED_SECRET || '';
  if (!apiKey || !secret) return null;
  const baseUrl = (env.ERP_BASE_URL || DEFAULT_ERP_BASE_URL).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(baseUrl)) return null;
  return { baseUrl, apiKey, secret };
}

/** Runs a batch through the normal /api/erp/events handler; returns its HTTP status and JSON body. */
export type BatchHandler = (rawBody: string, signature: string, apiKey: string) => Promise<{ status: number; json: unknown }>;

export interface PullDeps {
  fetch: typeof fetch;
  handle: BatchHandler;
  now?: () => Date;
  log?: (msg: string) => void;
}

async function signedPost(deps: PullDeps, cfg: PullConfig, path: string, payload: unknown) {
  const raw = JSON.stringify(payload);
  const res = await deps.fetch(`${cfg.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
      'X-ERP-Signature': `sha256=${hmacHex(raw, cfg.secret)}`,
    },
    body: raw,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, ok: res.ok, json, text };
}

export type PullResult =
  | { kind: 'empty' }
  | { kind: 'processed'; count: number; status: number }
  | { kind: 'error'; detail: string };

/** One collect → process → acknowledge round. */
export async function pullOnce(cfg: PullConfig, deps: PullDeps): Promise<PullResult> {
  const now = deps.now ?? (() => new Date());
  const pulled = await signedPost(deps, cfg, '/api/crm/pull', { source: 'wacrm', at: now().toISOString() });
  if (!pulled.ok) return { kind: 'error', detail: `pull: HTTP ${pulled.status} ${pulled.text.slice(0, 200)}` };

  const batch = (pulled.json as { batch?: { body?: unknown; signature?: unknown; ids?: unknown } } | null)?.batch;
  if (!batch) return { kind: 'empty' };
  const body = typeof batch.body === 'string' ? batch.body : '';
  const signature = typeof batch.signature === 'string' ? batch.signature : '';
  const ids = Array.isArray(batch.ids) ? batch.ids.map(String) : [];
  // Only a batch the ERP really signed is processed. The ack still
  // goes back so the ERP does not wait five minutes for the lease.
  if (!body || !verifyEventSignature(body, signature, cfg.secret)) {
    await signedPost(deps, cfg, '/api/crm/pull/ack', { ids, status: 401, error: 'batch signature did not verify on the CRM' }).catch(() => {});
    return { kind: 'error', detail: 'batch signature did not verify' };
  }

  let status: number;
  let json: unknown;
  try {
    ({ status, json } = await deps.handle(body, signature, cfg.apiKey));
  } catch (err) {
    status = 500;
    json = { error: err instanceof Error ? err.message : String(err) };
  }
  const acked = await signedPost(deps, cfg, '/api/crm/pull/ack', { ids, status, response: json });
  if (!acked.ok) return { kind: 'error', detail: `ack: HTTP ${acked.status} ${acked.text.slice(0, 200)}` };
  return { kind: 'processed', count: ids.length, status };
}

/** One timer tick: drain while batches come back full. */
export async function pullTick(cfg: PullConfig, deps: PullDeps): Promise<void> {
  const log = deps.log ?? ((m: string) => console.warn(m));
  for (let i = 0; i < MAX_BATCHES_PER_TICK; i++) {
    let r: PullResult;
    try {
      r = await pullOnce(cfg, deps);
    } catch (err) {
      log(`[erp/pull] ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (r.kind === 'error') { log(`[erp/pull] ${r.detail}`); return; }
    if (r.kind === 'empty' || r.count < BATCH_SIZE) return;
  }
}

/** Starts the collector once per server process (Node runtime). Safe to call more than once. */
export function startErpPull(cfg: PullConfig | null, deps: PullDeps): boolean {
  const g = globalThis as typeof globalThis & { __erpPullTimer?: ReturnType<typeof setInterval> };
  if (!cfg || g.__erpPullTimer) return false;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await pullTick(cfg, deps); } finally { busy = false; }
  };
  g.__erpPullTimer = setInterval(tick, PULL_INTERVAL_MS);
  // Do not keep a process alive just for this timer.
  (g.__erpPullTimer as { unref?: () => void }).unref?.();
  setTimeout(tick, 5_000);
  console.info(`[erp/pull] collecting ERP events from ${cfg.baseUrl} every ${PULL_INTERVAL_MS / 1000}s`);
  return true;
}
