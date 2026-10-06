// ============================================================
// The branch send-gate: which branches may actually receive
// WhatsApp messages.
//
// Why this exists
//
//   The ERP has a demo store. A test order placed in it carries a
//   real phone number, and without this gate the CRM would cheerfully
//   send that number a real "your order is ready". The branch name
//   simply would not match any CRM store, which is logged and
//   deliberately non-fatal — so the message goes out anyway. That
//   default is right for a typo in a real branch name (never block a
//   paying customer's message over a spelling mistake) and wrong for
//   a demo store, and nothing in the data distinguishes the two.
//
//   It is also how a rollout starts on one branch: run live for a
//   week on one shop, with every other shop's customers still being
//   created, filed and visible in the CRM, just not messaged.
//
// The gate is OFF by default. Unset the env var and every branch
// sends, which is the behaviour every existing deployment has.
//
// Matching reuses the store-name normalisation (case, spaces and
// punctuation stripped), so `Demo Store`, `demo-store` and `DEMO
// STORE` are the same branch, and a CRM store's short code works too.
// ============================================================

import { normalizeStoreKey } from './process';

/**
 * Parse the allow-list: comma-separated branch names or codes,
 * whitespace trimmed, empties dropped.
 *
 * Returns an empty array for unset, empty, or all-whitespace — all of
 * which mean "no gate", never "block everything". Getting that
 * backwards would silence a live shop the first time someone saved a
 * stray comma.
 */
export function parseAllowedBranches(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => normalizeStoreKey(part))
    .filter((part) => part.length > 0);
}

export interface SendGateDecision {
  send: boolean;
  /** Why not, for the event ledger. Absent when sending. */
  reason?: string;
}

/**
 * Decide whether an event for `branch` may send its message.
 *
 * With the gate off, everything sends. With it on:
 *
 *   - a branch on the list sends;
 *   - a branch not on the list does not;
 *   - an event with NO branch does not.
 *
 * That last case is the one worth stating. `customer.birthday`
 * carries no branch, so a birthday wish is held back while the gate
 * is on. Fail-closed is the only safe reading during a trial: the
 * whole point is that nobody outside the named branches is messaged,
 * and "we could not tell which branch" is not evidence that they are
 * inside it.
 */
export function shouldSendForBranch(
  branch: string | null | undefined,
  allowed: string[],
): SendGateDecision {
  if (allowed.length === 0) return { send: true };

  if (!branch) {
    return {
      send: false,
      reason: `held back: sending is limited to ${allowed.join(', ')} and this event names no branch`,
    };
  }

  const key = normalizeStoreKey(branch);
  if (allowed.includes(key)) return { send: true };

  return {
    send: false,
    reason: `held back: sending is limited to ${allowed.join(', ')}, this event is for ${branch}`,
  };
}
