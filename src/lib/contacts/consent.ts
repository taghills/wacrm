// ============================================================
// Marketing consent, driven by what the customer types.
//
// WhatsApp policy requires an easy, honoured opt-out for marketing
// messages. A customer replying "STOP" expects the birthday wishes
// and the eye-test reminders to end, and they expect it to work
// without anyone at the shop doing anything.
//
// What this does NOT stop: transactional messages about an order
// they placed — "your glasses are ready", "payment received". Those
// are service messages, the customer asked for the underlying
// transaction, and suppressing them would be a worse outcome than
// the opt-out was asking for. See migration 049.
//
// The matcher is deliberately strict: the whole message must be the
// keyword. "Stop sending them to the Rohini branch, send to
// Bahadurgarh" is a delivery instruction, not an opt-out, and
// silently muting that customer would be a real failure.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

/** Messages that mean "stop marketing to me". */
const OPT_OUT_KEYWORDS = ['stop', 'unsubscribe', 'opt out', 'optout'];

/** Messages that mean "start again". */
const OPT_IN_KEYWORDS = ['start', 'subscribe', 'opt in', 'optin', 'resume'];

export type ConsentKeyword = 'opt_out' | 'opt_in' | null;

/**
 * Classify an inbound message as a consent instruction, or not.
 *
 * Case-insensitive, tolerant of surrounding whitespace and trailing
 * punctuation ("STOP."), but it must be the entire message.
 */
export function parseConsentKeyword(text: string | null | undefined): ConsentKeyword {
  if (typeof text !== 'string') return null;
  const normalized = text.trim().toLowerCase().replace(/[.!¡?]+$/, '').trim();
  if (normalized.length === 0) return null;
  if (OPT_OUT_KEYWORDS.includes(normalized)) return 'opt_out';
  if (OPT_IN_KEYWORDS.includes(normalized)) return 'opt_in';
  return null;
}

/**
 * Record a consent change, if the message was one. Returns what it
 * did, so the caller can log it.
 *
 * Never throws: this runs inside the inbound webhook's `after()`
 * block, where a failure would be invisible to the sender anyway,
 * and an un-recorded opt-out must not take the whole inbound
 * message down with it.
 */
export async function applyConsentKeyword(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  text: string | null | undefined,
): Promise<ConsentKeyword> {
  const keyword = parseConsentKeyword(text);
  if (!keyword) return null;

  const optedOut = keyword === 'opt_out';
  const { error } = await db
    .from('contacts')
    .update({
      marketing_opt_out: optedOut,
      marketing_opt_out_at: optedOut ? new Date().toISOString() : null,
    })
    .eq('id', contactId)
    .eq('account_id', accountId);

  if (error) {
    console.error('[consent] could not record', keyword, error.message);
    return null;
  }
  return keyword;
}
