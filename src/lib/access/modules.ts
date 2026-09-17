// ============================================================
// UI access modules — the catalogue of things an access role can
// show, show read-only, or hide.
//
// SCOPE, stated once and meant literally: this file decides what a
// member is RENDERED. It is not an authorization boundary. The real
// boundaries are `account_role` + `is_account_member()` for
// settings-class tables and `can_access_contact()` (migration 043)
// for customer data, both enforced in RLS. Someone who types a URL
// reaches the page; the database is what stops them changing
// anything they shouldn't.
//
// The one-way rule
//
//   An access role may only ever narrow what the member's
//   account_role already allows. `resolveLevel` clamps to the
//   account_role default, so granting `edit` on WhatsApp to an
//   agent renders nothing extra — it would only produce a form
//   whose save the database refuses, which is a worse experience
//   than not showing it.
// ============================================================

import type { AccountRole } from '@/lib/auth/roles';

/** What a member may do with a module, weakest first. */
export const ACCESS_LEVELS = ['hidden', 'view', 'edit'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export function levelRank(level: AccessLevel): number {
  return ACCESS_LEVELS.indexOf(level);
}

export function isAccessLevel(value: unknown): value is AccessLevel {
  return (
    typeof value === 'string' &&
    (ACCESS_LEVELS as readonly string[]).includes(value)
  );
}

/**
 * Module ids. Nav items are bare (`inbox`); settings sections are
 * prefixed (`settings.whatsapp`) so the two namespaces can't collide
 * and the settings rail can filter on the prefix alone.
 */
export const ACCESS_MODULES = [
  'dashboard',
  'inbox',
  'notifications',
  'contacts',
  'pipelines',
  'broadcasts',
  'automations',
  'flows',
  'agents',
  'settings',
  'settings.profile',
  'settings.security',
  'settings.appearance',
  'settings.whatsapp',
  'settings.templates',
  'settings.quick-replies',
  'settings.fields',
  'settings.deals',
  'settings.stores',
  'settings.members',
  'settings.roles',
  'settings.api',
] as const;

export type AccessModule = (typeof ACCESS_MODULES)[number];

export function isAccessModule(value: unknown): value is AccessModule {
  return (
    typeof value === 'string' &&
    (ACCESS_MODULES as readonly string[]).includes(value)
  );
}

export interface ModuleMeta {
  id: AccessModule;
  /** Grouping for the role editor UI. */
  group: 'workspace' | 'settings';
  /** Fallback English label; the editor prefers the i18n string. */
  label: string;
}

export const MODULE_META: Record<AccessModule, ModuleMeta> = {
  dashboard: { id: 'dashboard', group: 'workspace', label: 'Dashboard' },
  inbox: { id: 'inbox', group: 'workspace', label: 'Inbox' },
  notifications: { id: 'notifications', group: 'workspace', label: 'Notifications' },
  contacts: { id: 'contacts', group: 'workspace', label: 'Contacts' },
  pipelines: { id: 'pipelines', group: 'workspace', label: 'Pipelines' },
  broadcasts: { id: 'broadcasts', group: 'workspace', label: 'Broadcasts' },
  automations: { id: 'automations', group: 'workspace', label: 'Automations' },
  flows: { id: 'flows', group: 'workspace', label: 'Flows' },
  agents: { id: 'agents', group: 'workspace', label: 'AI Agents' },
  settings: { id: 'settings', group: 'workspace', label: 'Settings' },
  'settings.profile': { id: 'settings.profile', group: 'settings', label: 'Your profile' },
  'settings.security': { id: 'settings.security', group: 'settings', label: 'Login & security' },
  'settings.appearance': { id: 'settings.appearance', group: 'settings', label: 'Appearance' },
  'settings.whatsapp': { id: 'settings.whatsapp', group: 'settings', label: 'WhatsApp' },
  'settings.templates': { id: 'settings.templates', group: 'settings', label: 'Templates' },
  'settings.quick-replies': { id: 'settings.quick-replies', group: 'settings', label: 'Quick replies' },
  'settings.fields': { id: 'settings.fields', group: 'settings', label: 'Fields & tags' },
  'settings.deals': { id: 'settings.deals', group: 'settings', label: 'Deals & currency' },
  'settings.stores': { id: 'settings.stores', group: 'settings', label: 'Stores' },
  'settings.members': { id: 'settings.members', group: 'settings', label: 'Team members' },
  'settings.roles': { id: 'settings.roles', group: 'settings', label: 'Roles & access' },
  'settings.api': { id: 'settings.api', group: 'settings', label: 'API keys' },
};

/** A saved role's permission map. Missing keys fall back to defaults. */
export type AccessPermissions = Partial<Record<AccessModule, AccessLevel>>;

// ============================================================
// DEFAULTS PER ACCOUNT ROLE
//
// What a member sees when no access role is assigned. These are
// also the ceiling every access role is clamped to.
//
// The settings split follows what RLS already enforces: the
// sections backed by admin-gated tables (WhatsApp, templates,
// stores, members, roles, API keys, currency, custom fields) are
// hidden from agent and viewer, because their writes are refused
// there anyway and showing them only invites a failed save. The
// personal sections (profile, security, appearance) and the ones
// agents genuinely work in (quick replies) stay.
// ============================================================

const ADMIN_SETTINGS: AccessModule[] = [
  'settings.whatsapp',
  'settings.templates',
  'settings.fields',
  'settings.deals',
  'settings.stores',
  'settings.members',
  'settings.roles',
  'settings.api',
];

function everything(level: AccessLevel): Record<AccessModule, AccessLevel> {
  return Object.fromEntries(
    ACCESS_MODULES.map((m) => [m, level]),
  ) as Record<AccessModule, AccessLevel>;
}

function agentDefaults(base: AccessLevel): Record<AccessModule, AccessLevel> {
  const map = everything(base);
  for (const m of ADMIN_SETTINGS) map[m] = 'hidden';
  return map;
}

export const DEFAULT_PERMISSIONS: Record<
  AccountRole,
  Record<AccessModule, AccessLevel>
> = {
  owner: everything('edit'),
  admin: everything('edit'),
  agent: agentDefaults('edit'),
  // A viewer may read their own account pages but changes nothing.
  viewer: (() => {
    const map = agentDefaults('view');
    map['settings.profile'] = 'edit';
    map['settings.security'] = 'edit';
    map['settings.appearance'] = 'edit';
    return map;
  })(),
};

/**
 * The level a member actually gets for a module.
 *
 * `role` may raise nothing: the result is the weaker of the saved
 * level and the account_role default. A module absent from `role`
 * uses the default unchanged, so a release that adds a module does
 * not hide it from everyone holding a saved role.
 */
export function resolveLevel(
  accountRole: AccountRole | null,
  permissions: AccessPermissions | null,
  module: AccessModule,
): AccessLevel {
  if (!accountRole) return 'hidden';
  const ceiling = DEFAULT_PERMISSIONS[accountRole][module];
  const requested = permissions?.[module];
  if (!requested) return ceiling;
  return levelRank(requested) < levelRank(ceiling) ? requested : ceiling;
}

/** Narrow an unknown JSON blob to a valid permission map. */
export function parsePermissions(raw: unknown): AccessPermissions {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: AccessPermissions = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (isAccessModule(k) && isAccessLevel(v)) out[k] = v;
  }
  return out;
}
