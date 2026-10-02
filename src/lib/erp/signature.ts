// ============================================================
// HMAC verification for the TAGHills ERP integration.
//
// Two things arrive from the ERP, both signed with the same shared
// secret (`ERP_SHARED_SECRET`, the ERP's `CRM_SHARED_SECRET`):
//
//   1. Event batches  — POST /api/erp/events, signature over the
//      RAW request body in `X-ERP-Signature: sha256=<hex>`.
//   2. SSO tokens     — GET /auth/erp?token=<payload>.<sig>,
//      signature over the base64url payload part.
//
// Both comparisons are constant time. A fast-path `===` would leak
// the correct signature one byte at a time to anyone who can time
// our responses, which is the whole attack this header exists to
// prevent.
//
// Everything here is pure (secret passed in, never read from
// `process.env`) so the tests can exercise it without touching the
// environment, and so a caller cannot accidentally verify against a
// secret that was undefined at import time.
// ============================================================

import crypto from 'node:crypto';

/**
 * Constant-time string compare that tolerates different lengths.
 *
 * `crypto.timingSafeEqual` throws when the buffers differ in length,
 * so the length check has to happen first. That does leak the
 * *length* of the expected signature — which is a fixed 64 hex chars
 * for SHA-256 and therefore public knowledge.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Lowercase hex HMAC-SHA256 of `payload` under `secret`. */
export function hmacHex(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/** base64url (no padding) of a buffer — the form the ERP's tokens use. */
export function base64url(input: Buffer): string {
  return input.toString('base64url');
}

/** base64url HMAC-SHA256 of `payload` under `secret`. */
export function hmacBase64Url(payload: string, secret: string): string {
  return base64url(crypto.createHmac('sha256', secret).update(payload).digest());
}

/**
 * Verify the `X-ERP-Signature` header against the raw request body.
 *
 * The header is `sha256=<lowercase hex>` — the shape `openssl dgst
 * -sha256 -hmac` produces, which is what the ERP uses and what the
 * handover's manual curl test produces.
 *
 * Fails closed on a missing secret: without one there is nothing to
 * verify against, and accepting the request would mean an unsigned
 * endpoint that can create contacts and send WhatsApp messages.
 */
export function verifyEventSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string | undefined,
): boolean {
  if (!secret) return false;
  if (!signatureHeader) return false;
  if (!signatureHeader.startsWith('sha256=')) return false;
  return safeEqual(signatureHeader, `sha256=${hmacHex(rawBody, secret)}`);
}

/**
 * Verify the bearer token the ERP sends on every event request.
 *
 * This is a shared static credential, not a hash — but it is still
 * compared in constant time, for the same reason as the signature.
 */
export function verifyBearer(
  authorizationHeader: string | null,
  expected: string | undefined,
): boolean {
  if (!expected) return false;
  if (!authorizationHeader) return false;
  const presented = authorizationHeader.startsWith('Bearer ')
    ? authorizationHeader.slice('Bearer '.length).trim()
    : authorizationHeader.trim();
  if (presented.length === 0) return false;
  return safeEqual(presented, expected);
}
