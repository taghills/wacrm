// ============================================================
// /api/access-roles
//
//   GET  — list the account's UI access roles. Any member: the
//          Team members screen labels each row with its role name.
//   POST — create a role. Admin+.
//
// These roles govern rendering only — see the scope note in
// @/lib/access/modules. The admin gate here mirrors
// access_roles_insert in migration 045.
// ============================================================

import { NextResponse } from 'next/server';

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { isAccessLevel, isAccessModule } from '@/lib/access/modules';

const NAME_MAX = 60;

/**
 * Keep only recognised module/level pairs. Unknown keys are dropped
 * rather than rejected: a client on an older build posting a module
 * this release removed should not fail the whole save.
 */
export function sanitizePermissions(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (isAccessModule(k) && isAccessLevel(v)) out[k] = v;
  }
  return out;
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    const { data, error } = await ctx.supabase
      .from('access_roles')
      .select('id, name, permissions, created_at')
      .eq('account_id', ctx.accountId)
      .order('name', { ascending: true });

    if (error) {
      console.error('[GET /api/access-roles] fetch error:', error);
      return NextResponse.json(
        { error: 'Failed to load roles' },
        { status: 500 },
      );
    }

    return NextResponse.json({ roles: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:accessRoleCreate:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      name?: unknown;
      permissions?: unknown;
    } | null;

    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > NAME_MAX) {
      return NextResponse.json(
        { error: `'name' is required and must be at most ${NAME_MAX} characters` },
        { status: 400 },
      );
    }

    const { data, error } = await ctx.supabase
      .from('access_roles')
      .insert({
        account_id: ctx.accountId,
        name,
        permissions: sanitizePermissions(body?.permissions),
      })
      .select('id, name, permissions, created_at')
      .single();

    if (error) {
      if (error.code === '23505') {
        return NextResponse.json(
          { error: 'A role with that name already exists' },
          { status: 409 },
        );
      }
      console.error('[POST /api/access-roles] insert error:', error);
      return NextResponse.json(
        { error: 'Failed to create role' },
        { status: 500 },
      );
    }

    return NextResponse.json({ role: data }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
