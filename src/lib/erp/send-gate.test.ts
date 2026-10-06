import { describe, it, expect } from 'vitest';

import { parseAllowedBranches, shouldSendForBranch } from './send-gate';

describe('parseAllowedBranches', () => {
  it('splits on commas and normalises each entry', () => {
    expect(parseAllowedBranches('Demo Store, SHNR')).toEqual([
      'demostore',
      'shnr',
    ]);
  });

  it('treats unset, empty and whitespace as NO gate', () => {
    // The dangerous direction: reading these as "block everything"
    // would silence every live shop the first time someone saved a
    // stray comma.
    expect(parseAllowedBranches(undefined)).toEqual([]);
    expect(parseAllowedBranches('')).toEqual([]);
    expect(parseAllowedBranches('   ')).toEqual([]);
    expect(parseAllowedBranches(',,')).toEqual([]);
  });
});

describe('shouldSendForBranch', () => {
  const gate = parseAllowedBranches('Demo Store');

  it('sends everything when the gate is off', () => {
    expect(shouldSendForBranch('Shastri Nagar', []).send).toBe(true);
    expect(shouldSendForBranch(null, []).send).toBe(true);
  });

  it('sends for a branch on the list', () => {
    expect(shouldSendForBranch('Demo Store', gate).send).toBe(true);
  });

  it('ignores case, spaces and punctuation', () => {
    for (const spelling of ['demo store', 'DEMO-STORE', 'demostore', ' Demo  Store ']) {
      expect(shouldSendForBranch(spelling, gate).send).toBe(true);
    }
  });

  it('holds back a branch that is not on the list', () => {
    const decision = shouldSendForBranch('Shastri Nagar', gate);
    expect(decision.send).toBe(false);
    expect(decision.reason).toContain('Shastri Nagar');
  });

  it('holds back an event with no branch at all', () => {
    // customer.birthday carries no branch. During a trial "we could
    // not tell which branch" is not evidence that it is the allowed
    // one, so it must not send.
    expect(shouldSendForBranch(null, gate).send).toBe(false);
    expect(shouldSendForBranch('', gate).send).toBe(false);
    expect(shouldSendForBranch('   ', gate).send).toBe(false);
  });

  it('names the allowed branches in the reason, for the ledger', () => {
    expect(shouldSendForBranch('Rohini Sector-7', gate).reason).toContain(
      'demostore',
    );
  });
});
