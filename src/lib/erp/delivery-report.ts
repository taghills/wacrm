// ============================================================
// Telling the ERP which messages WhatsApp could NOT deliver.
//
// The ERP hands an event over, the CRM sends the WhatsApp message and
// answers "sent" — and that is the last the ERP heard. Seconds later
// Meta's status webhook may say the message FAILED ("Message
// undeliverable": usually a number that is not on WhatsApp). That
// reached only the message row here, so the ERP's Home screen and
// "Check a bill" kept saying "sent" and nobody was warned.
//
// After every pull tick, this collects the failures of messages that
// came from ERP events (erp_events.message_id → messages.status =
// 'failed', migration 055's join) and reports them to the ERP
// (POST <erp>/api/crm/pull/delivery, signed like the pull). The ERP
// marks those events "undelivered" with a plain reason.
//
// No migration: what was reported is remembered per server process,
// and the ERP takes a repeat harmlessly — after a restart the last
// seven days are simply reported once more.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

/** How far back failures are reported. */
export const DELIVERY_REPORT_DAYS = 7;
const MAX_PER_TICK = 200;

export interface DeliveryFailure {
  id: string; // the ERP's event id
  code: number | null;
  title: string | null;
  details: string | null;
}

export type SignedPoster = (
  path: string,
  payload: unknown,
) => Promise<{ ok: boolean; status: number; json: unknown }>;

function first(v: unknown): Record<string, unknown> | null {
  if (Array.isArray(v)) return (v[0] as Record<string, unknown>) ?? null;
  return (v as Record<string, unknown>) ?? null;
}

/** Failed messages that came from ERP events in the last DELIVERY_REPORT_DAYS, oldest first. */
export async function collectFailures(db: SupabaseClient, now: Date = new Date()): Promise<DeliveryFailure[]> {
  const since = new Date(now.getTime() - DELIVERY_REPORT_DAYS * 86_400_000).toISOString();
  const { data, error } = await db
    .from('erp_events')
    .select('event_id, received_at, messages!inner(status, error_code, error_title, error_details)')
    .not('message_id', 'is', null)
    .eq('messages.status', 'failed')
    .gte('received_at', since)
    .limit(1000);
  if (error) throw new Error(`reading failed messages: ${error.message}`);
  const out: DeliveryFailure[] = [];
  for (const raw of data ?? []) {
    const row = raw as Record<string, unknown>;
    const m = first(row.messages);
    const id = String(row.event_id ?? '').trim();
    if (!m || m.status !== 'failed' || !/^\d+$/.test(id)) continue;
    const code = Number(m.error_code);
    out.push({
      id,
      code: Number.isFinite(code) && code > 0 ? code : null,
      title: (m.error_title as string | null) ?? null,
      details: (m.error_details as string | null) ?? null,
    });
  }
  return out;
}

/** Event ids already reported by this server process. */
const reported = new Set<string>();

/** Test hook: forget what was reported. */
export function resetReported(): void {
  reported.clear();
}

/**
 * Reports failures the ERP has not been told about yet. Returns how many
 * the ERP took. An ERP that does not know the address yet (HTTP 404, an
 * older ERP) is not an error: nothing is marked, it is tried again later.
 */
export async function reportDeliveryFailures(db: SupabaseClient, post: SignedPoster, now: Date = new Date()): Promise<number> {
  const fresh = (await collectFailures(db, now)).filter((f) => !reported.has(f.id)).slice(0, MAX_PER_TICK);
  if (!fresh.length) return 0;
  const res = await post('/api/crm/pull/delivery', { reports: fresh });
  if (res.status === 404) return 0;
  if (!res.ok) throw new Error(`delivery report: HTTP ${res.status}`);
  const accepted = (res.json as { accepted?: unknown } | null)?.accepted;
  const ids = Array.isArray(accepted) ? accepted.map(String) : [];
  for (const id of ids) reported.add(id);
  return ids.length;
}
