// ============================================================
// Single sign-on from the TAGHills ERP.
//
// The ERP renders this CRM in an iframe. Rather than asking staff to
// log in twice, it mints a short-lived signed token and loads
// `/auth/erp?token=<payload>.<sig>`; this module is the verification
// half.
//
// Token format (set by the ERP, mirrored here):
//
//   payload = base64url(JSON.stringify({ sub, email, name, username,
//                                        role, iat, exp, nonce, next }))
//   sig     = base64url(HMAC_SHA256(payload, ERP_SHARED_SECRET))
//   token   = payload + "." + sig
//
// `exp` is iat + 60s. A minute is plenty for a redirect and short
// enough that a token captured from a server log or a referrer
// header is almost certainly already dead.
//
// This module is pure: no env reads, no DB, no cookies. The route
// owns those. That keeps every refusal reason directly testable.
// ============================================================

import { hmacBase64Url, safeEqual } from './signature';

/**
 * ERP roles allowed to reach the CRM.
 *
 * The ERP has roles that have no business in a customer-messaging
 * tool (cashier, optometrist, read-only auditor). Rather than trust
 * the ERP to only mint tokens for the right people, we re-check here:
 * the token says who you are, this list says whether that is enough.
 *
 * Compared case-insensitively — the ERP spells one of these
 * `CompanyAdmin` and the rest lowercase, and a casing change on their
 * side should not silently lock everyone out.
 */
export const ALLOWED_ERP_ROLES = [
  'admin',
  'owner',
  'companyadmin',
  'manager',
] as const;

export interface ErpSsoPayload {
  /** The ERP's own user id. Carried for logging, not used as a key. */
  sub?: string;
  email?: string;
  name?: string;
  username?: string;
  role?: string;
  iat?: number;
  /** Unix seconds. Required — a token with no expiry is refused. */
  exp?: number;
  nonce?: string;
  /** Where to land after sign-in. Must be a site-relative path. */
  next?: string;
}

export type SsoFailure =
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  | 'role_not_allowed'
  | 'no_identity';

export type SsoVerifyResult =
  | { ok: true; payload: ErpSsoPayload; email: string; next: string }
  | { ok: false; reason: SsoFailure };

/** Default landing page when the token carries no usable `next`. */
export const DEFAULT_NEXT = '/dashboard';

/**
 * Reduce a caller-supplied `next` to a safe, site-relative path.
 *
 * Refused (and replaced with the default):
 *   - anything not starting with `/`           → absolute URL
 *   - `//evil.com/x`                           → protocol-relative URL
 *   - `/\evil.com`                             → backslash, which some
 *     browsers normalise to `/` and would turn into a protocol-
 *     relative URL after all
 *
 * The point is that a redirect target arriving inside a signed token
 * is still attacker-chosen if the signing secret ever leaks, and an
 * open redirect out of an authenticated session is a phishing
 * primitive. Validating costs nothing.
 */
export function sanitizeNext(next: unknown): string {
  if (typeof next !== 'string' || next.length === 0) return DEFAULT_NEXT;
  if (!next.startsWith('/')) return DEFAULT_NEXT;
  if (next.startsWith('//')) return DEFAULT_NEXT;
  if (next.startsWith('/\\')) return DEFAULT_NEXT;
  return next;
}

/** True when `role` is one the ERP may sign into the CRM with. */
export function isAllowedErpRole(role: unknown): boolean {
  if (typeof role !== 'string') return false;
  const normalized = role.trim().toLowerCase();
  return (ALLOWED_ERP_ROLES as readonly string[]).includes(normalized);
}

/**
 * The CRM-side identity for an ERP user.
 *
 * Email is the join key: ERP staff and CRM staff are the same people
 * and the CRM already keys users by email. When the ERP has no email
 * for someone we synthesise `<username>@erp.local` so the account is
 * still stable and still unique — it just can't receive mail, which
 * is fine for a user who only ever arrives via SSO.
 */
export function resolveSsoEmail(payload: ErpSsoPayload): string | null {
  const email = typeof payload.email === 'string' ? payload.email.trim() : '';
  if (email.includes('@')) return email.toLowerCase();

  const username =
    typeof payload.username === 'string' ? payload.username.trim() : '';
  if (username.length > 0) {
    return `${username.toLowerCase()}@erp.local`;
  }
  return null;
}

/**
 * Verify an SSO token end to end.
 *
 * Order matters: signature first, then expiry, then role. Checking
 * the payload's claims before the signature would mean acting on
 * attacker-controlled JSON.
 *
 * `now` is injectable so the expiry tests don't depend on wall-clock
 * timing.
 */
export function verifyErpSsoToken(
  token: string | null | undefined,
  secret: string | undefined,
  now: Date = new Date(),
): SsoVerifyResult {
  if (!secret) return { ok: false, reason: 'bad_signature' };
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, reason: 'malformed' };
  }

  // Exactly two parts. A token with extra dots is malformed, not
  // "payload with a dot in it" — base64url has no `.` in its alphabet.
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [payloadPart, signaturePart] = parts;
  if (!payloadPart || !signaturePart) return { ok: false, reason: 'malformed' };

  if (!safeEqual(signaturePart, hmacBase64Url(payloadPart, secret))) {
    return { ok: false, reason: 'bad_signature' };
  }

  // Signature is good, so the bytes are ours — but they could still
  // be malformed if the ERP ships a bug, and a throw here would be a
  // 500 on a request we should answer with a 401.
  let payload: ErpSsoPayload;
  try {
    const decoded = Buffer.from(payloadPart, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(decoded);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'malformed' };
    }
    payload = parsed as ErpSsoPayload;
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  // No `exp` means no expiry, which would make a leaked token a
  // permanent key to the CRM. Treat it as expired rather than
  // generous.
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
    return { ok: false, reason: 'expired' };
  }
  if (payload.exp * 1000 <= now.getTime()) {
    return { ok: false, reason: 'expired' };
  }

  if (!isAllowedErpRole(payload.role)) {
    return { ok: false, reason: 'role_not_allowed' };
  }

  const email = resolveSsoEmail(payload);
  if (!email) return { ok: false, reason: 'no_identity' };

  return { ok: true, payload, email, next: sanitizeNext(payload.next) };
}
