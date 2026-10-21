import { describe, it, expect } from 'vitest';

import { contactBranchName } from './contact-branch';

describe('contactBranchName', () => {
  it('names the one store a contact belongs to', () => {
    expect(contactBranchName([{ stores: { name: 'Shastri Nagar', active: true } }])).toBe('Shastri Nagar');
  });

  it('accepts the embedded store as an array', () => {
    expect(contactBranchName([{ stores: [{ name: 'Bahadurgarh', active: true }] }])).toBe('Bahadurgarh');
  });

  it('gives no answer for a contact linked to two stores', () => {
    // Guessing would alert the wrong shop; the receiver falls back.
    expect(
      contactBranchName([
        { stores: { name: 'Shastri Nagar', active: true } },
        { stores: { name: 'Bahadurgarh', active: true } },
      ]),
    ).toBeNull();
  });

  it('ignores inactive stores and blank names', () => {
    expect(
      contactBranchName([
        { stores: { name: 'Old shop', active: false } },
        { stores: { name: '  ', active: true } },
        { stores: { name: 'Rohini sector 7', active: true } },
      ]),
    ).toBe('Rohini sector 7');
  });

  it('gives no answer when there are no links', () => {
    expect(contactBranchName([])).toBeNull();
    expect(contactBranchName(null)).toBeNull();
    expect(contactBranchName([{ stores: null }])).toBeNull();
  });
});
