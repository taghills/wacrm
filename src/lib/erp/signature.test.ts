import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';

import {
  hmacBase64Url,
  hmacHex,
  safeEqual,
  verifyBearer,
  verifyEventSignature,
} from './signature';

const SECRET = 'a'.repeat(64);
const BODY = '{"source":"taghills-erp","events":[{"id":"t1","type":"ping","data":{}}]}';

const signBody = (body: string, secret = SECRET) =>
  `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;

describe('safeEqual', () => {
  it('is true for identical strings', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
  });

  it('is false for different strings of the same length', () => {
    expect(safeEqual('abc', 'abd')).toBe(false);
  });

  it('is false (not a throw) for different lengths', () => {
    // timingSafeEqual throws on a length mismatch; the wrapper must
    // absorb that, or a short forged signature becomes a 500.
    expect(() => safeEqual('abc', 'abcd')).not.toThrow();
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('hmacHex', () => {
  it('matches what `openssl dgst -sha256 -hmac` produces', () => {
    // Lowercase hex, no prefix — the handover's manual curl test
    // pipes openssl straight into the header, so any change in
    // encoding here breaks that documented check.
    expect(hmacHex(BODY, SECRET)).toMatch(/^[0-9a-f]{64}$/);
    expect(hmacHex(BODY, SECRET)).toBe(
      crypto.createHmac('sha256', SECRET).update(BODY).digest('hex'),
    );
  });
});

describe('hmacBase64Url', () => {
  it('has no padding or URL-unsafe characters', () => {
    const sig = hmacBase64Url('payload', SECRET);
    expect(sig).not.toContain('=');
    expect(sig).not.toContain('+');
    expect(sig).not.toContain('/');
  });
});

describe('verifyEventSignature', () => {
  it('accepts a correctly signed body', () => {
    expect(verifyEventSignature(BODY, signBody(BODY), SECRET)).toBe(true);
  });

  it('rejects a body that changed after signing', () => {
    const tampered = BODY.replace('"ping"', '"order.ready"');
    expect(verifyEventSignature(tampered, signBody(BODY), SECRET)).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    expect(verifyEventSignature(BODY, signBody(BODY, 'b'.repeat(64)), SECRET)).toBe(
      false,
    );
  });

  it('rejects a missing header', () => {
    expect(verifyEventSignature(BODY, null, SECRET)).toBe(false);
  });

  it('rejects a header without the sha256= prefix', () => {
    const bare = signBody(BODY).slice('sha256='.length);
    expect(verifyEventSignature(BODY, bare, SECRET)).toBe(false);
  });

  it('fails closed when no secret is configured', () => {
    // The dangerous direction: an unset env var must not mean
    // "skip verification", or a misconfigured deploy is an open
    // endpoint that can send WhatsApp messages.
    expect(verifyEventSignature(BODY, signBody(BODY), undefined)).toBe(false);
    expect(verifyEventSignature(BODY, signBody(BODY), '')).toBe(false);
  });
});

describe('verifyBearer', () => {
  it('accepts the expected key with the Bearer prefix', () => {
    expect(verifyBearer('Bearer secret-key', 'secret-key')).toBe(true);
  });

  it('accepts a bare key without the prefix', () => {
    expect(verifyBearer('secret-key', 'secret-key')).toBe(true);
  });

  it('rejects a wrong key', () => {
    expect(verifyBearer('Bearer nope', 'secret-key')).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(verifyBearer(null, 'secret-key')).toBe(false);
  });

  it('rejects an empty presented key', () => {
    expect(verifyBearer('Bearer ', 'secret-key')).toBe(false);
  });

  it('fails closed when no key is configured', () => {
    expect(verifyBearer('Bearer anything', undefined)).toBe(false);
    expect(verifyBearer('Bearer anything', '')).toBe(false);
  });
});
