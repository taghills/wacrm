import { describe, it, expect } from 'vitest';

import { isAcknowledgement } from './acknowledgement';

describe('isAcknowledgement', () => {
  it.each([
    'ok', 'OK MAM', 'Okk', 'okay sir', 'Ok sir 👍', 'thank you so much',
    'Thanks ji 🙏', '👍', '🙏🙏', 'got it', 'theek hai', 'Accha ji', 'noted', 'k', 'thnx',
  ])('"%s" needs no reply', (text) => {
    expect(isAcknowledgement('text', text)).toBe(true);
  });

  it.each([
    'is my order ready?',
    // one real word beyond the courtesy makes it a question
    'ok when will it be ready',
    'ok done',
    // politeness alone is someone trying to get attention
    'sir',
    'yes',
    'haan',
    'Hello',
    '',
  ])('"%s" needs a reply', (text) => {
    expect(isAcknowledgement('text', text)).toBe(false);
  });

  it('never treats media as an acknowledgement', () => {
    // A photo captioned "ok" may still be a prescription.
    expect(isAcknowledgement('image', 'ok')).toBe(false);
    expect(isAcknowledgement('audio', null)).toBe(false);
  });

  it('treats a missing content type as text', () => {
    expect(isAcknowledgement(null, 'ok')).toBe(true);
  });

  it('does not stretch to a long message made of courtesy words', () => {
    expect(isAcknowledgement('text', 'ok ok ok thanks thanks sir ji')).toBe(false);
  });
});
