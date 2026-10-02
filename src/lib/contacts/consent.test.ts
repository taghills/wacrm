import { describe, it, expect } from 'vitest';

import { parseConsentKeyword } from './consent';

describe('parseConsentKeyword', () => {
  it('recognises the opt-out words on their own', () => {
    for (const text of ['STOP', 'stop', ' Stop ', 'STOP.', 'unsubscribe', 'opt out']) {
      expect(parseConsentKeyword(text)).toBe('opt_out');
    }
  });

  it('recognises the opt-in words on their own', () => {
    for (const text of ['START', 'start', 'subscribe', 'resume']) {
      expect(parseConsentKeyword(text)).toBe('opt_in');
    }
  });

  it('ignores a keyword used inside a normal sentence', () => {
    // The failure this prevents: a customer giving a delivery
    // instruction gets silently muted for every future reminder.
    expect(
      parseConsentKeyword('Stop sending to Rohini, deliver to Bahadurgarh'),
    ).toBeNull();
    expect(parseConsentKeyword('when can I start wearing them?')).toBeNull();
  });

  it('returns null for empty and non-string input', () => {
    expect(parseConsentKeyword('')).toBeNull();
    expect(parseConsentKeyword('   ')).toBeNull();
    expect(parseConsentKeyword(null)).toBeNull();
    expect(parseConsentKeyword(undefined)).toBeNull();
  });
});
