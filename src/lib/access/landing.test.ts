import { describe, expect, it } from 'vitest';

import { LAST_RESORT, redirectTarget } from './landing';
import type { AccessModule } from './modules';

/** canSee that hides exactly the listed modules. */
const hiding = (...hidden: AccessModule[]) =>
  (module: AccessModule) => !hidden.includes(module);

describe('redirectTarget', () => {
  it('leaves a member on a page they can see', () => {
    expect(redirectTarget('/dashboard', hiding())).toBeNull();
  });

  it('sends a member off a hidden Dashboard to Inbox', () => {
    // The case this exists for: /dashboard is where signing in lands
    // everyone, so hiding it without a bounce is a dead end.
    expect(redirectTarget('/dashboard', hiding('dashboard'))).toBe('/inbox');
  });

  it('falls through in sidebar order when several are hidden', () => {
    expect(
      redirectTarget('/dashboard', hiding('dashboard', 'inbox', 'notifications')),
    ).toBe('/contacts');
  });

  it('matches nested routes, not just the exact path', () => {
    expect(redirectTarget('/flows/abc-123', hiding('flows'))).toBe('/dashboard');
  });

  it('ignores paths outside the nav', () => {
    // /join/<token> must never be bounced — an invitee has no role yet.
    expect(redirectTarget('/join/tok123', hiding('dashboard'))).toBeNull();
  });

  it('falls back to the profile page when everything is hidden', () => {
    const all: AccessModule[] = [
      'dashboard', 'inbox', 'notifications', 'contacts', 'pipelines',
      'broadcasts', 'automations', 'flows', 'agents', 'settings',
    ];
    expect(redirectTarget('/dashboard', hiding(...all))).toBe(LAST_RESORT);
  });
});
