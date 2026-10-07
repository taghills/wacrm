// ============================================================
// The two numbers an operator controls: where the review request
// sends people, and how long after delivery it goes out.
//
// Stored per account in `message_settings` (migration 052). Before
// that they lived in REVIEW_LINK_URL, a hosting environment
// variable, and the delay did not exist at all.
//
// The environment variable is still honoured as a fallback, so a
// deployment that set it keeps working through the upgrade without
// anyone having to open Settings first. The database wins when both
// are present: a value someone typed into the app should not be
// overridden by one nobody can see.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

/** What the send path needs to know. */
export interface MessageSettings {
  /** The review link, or null when nobody has set one. */
  reviewUrl: string | null;
  /** Days after delivery before the review request falls due. */
  reviewDelayDays: number;
  /** Where reviewUrl came from, for the status page to report. */
  reviewUrlSource: 'settings' | 'env' | 'unset';
}

/**
 * The default delay, in days.
 *
 * Three, because a review asks for an opinion the customer does not
 * have on collection day: new lenses take a few days to settle, and
 * a complaint is better heard before the review page than after it.
 */
export const DEFAULT_REVIEW_DELAY_DAYS = 3;

/** The ceiling the database also enforces, repeated for validation. */
export const MAX_REVIEW_DELAY_DAYS = 90;

/**
 * Read an account's message settings, falling back to the
 * environment and then to the defaults.
 *
 * Never throws: a missing row is the normal state for an account
 * nobody has configured, and the send path has its own reasons to
 * skip. A read error is treated as "unset" and logged, because
 * failing an order confirmation over a review setting would be the
 * wrong trade.
 */
export async function resolveMessageSettings(
  db: SupabaseClient,
  accountId: string,
): Promise<MessageSettings> {
  const envUrl = normalizeUrl(process.env.REVIEW_LINK_URL);

  const { data, error } = await db
    .from('message_settings')
    .select('review_url, review_delay_days')
    .eq('account_id', accountId)
    .maybeSingle();

  if (error) {
    console.warn('[erp] message_settings read failed:', error.message);
  }

  const dbUrl = normalizeUrl(
    typeof data?.review_url === 'string' ? data.review_url : null,
  );

  const rawDelay = data?.review_delay_days;
  const reviewDelayDays =
    typeof rawDelay === 'number' && Number.isInteger(rawDelay)
      ? clampDelay(rawDelay)
      : DEFAULT_REVIEW_DELAY_DAYS;

  return {
    reviewUrl: dbUrl ?? envUrl,
    reviewDelayDays,
    reviewUrlSource: dbUrl ? 'settings' : envUrl ? 'env' : 'unset',
  };
}

/**
 * A review link we are willing to put on a WhatsApp button.
 *
 * Only https: Meta rejects a button URL that is not, and a link the
 * customer cannot open is worse than no message. Returns null for
 * anything else, including a blank string, so "unset" has one
 * representation everywhere.
 */
export function normalizeUrl(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const url = value.trim();
  if (!url) return null;
  if (!/^https:\/\/\S+$/i.test(url)) return null;
  return url;
}

/** Keep a delay inside the range the CHECK constraint allows. */
export function clampDelay(days: number): number {
  if (!Number.isFinite(days)) return DEFAULT_REVIEW_DELAY_DAYS;
  const whole = Math.trunc(days);
  if (whole < 0) return 0;
  if (whole > MAX_REVIEW_DELAY_DAYS) return MAX_REVIEW_DELAY_DAYS;
  return whole;
}

/**
 * When a review request for an order delivered now falls due.
 *
 * Deliberately a plain day offset rather than a time-of-day
 * schedule: the cron decides the hour it runs, and pinning a minute
 * here would promise a precision the drain cannot keep.
 */
export function reviewDueAt(delayDays: number, now: Date = new Date()): Date {
  const due = new Date(now.getTime());
  due.setUTCDate(due.getUTCDate() + clampDelay(delayDays));
  return due;
}
