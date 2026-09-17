// ============================================================
// /api/access-roles/[id]
//
//   PATCH  — rename a role or change its permissions. Admin+.
//   DELETE — remove a role. Admin+.
//
// Deleting is not destructive: profiles.access_role_id is
// ON DELETE SET NULL (migration 045), so holders fall back to the
// defaults for their account_role rather than losing access.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { sanitizePermissions } from '../route';

const NAME_MAX = 60;

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:accessRoleUpdate:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    const body = (await request.json().catch(() => null)) as {
      name?: unknown;
      permissions?: unknown;
    } | null;

    const patch: Record<string, unknown> = {};

    if (body?.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > NAME_MAX) {
        return NextResponse.json(
          { error: `'name' must be 1-${NAME_MAX} characters` },
          { status: 400 },
        );
      }
      patch.name = name;
    }

    if (body?.permissions !== undefined) {
      patch.permissions = sanitizePermissions(body.permissions);
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
    }

    // access_roles_update already scopes the row to the caller's
    // account; a miss returns zero rows rather than touching another.
    const { data, error } = await ctx.supabase
      .from('access_roles')
      .update(patch)
      .eq('id', id)
      .select('id, name, permissions, created_at')
      .maybeSingle();

    if (error) {
      if (error.code === '23505') {
        return NextResponse.json(
          { error: 'A role with that name already exists' },
          { status: 409 },
        );
      }
      console.error('[PATCH /api/access-roles/[id]] update error:', error);
      return NextResponse.json(
        { error: 'Failed to update role' },
        { status: 500 },
      );
    }

    if (!data) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    return NextResponse.json({ role: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:accessRoleDelete:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;

    // Read first so a row RLS filtered out reports 404 rather than a
    // misleading success — DELETE reports no rows either way.
    const { data: existing } = await ctx.supabase
      .from('access_roles')
      .select('id')
      .eq('id', id)
      .maybeSingle();

    if (!existing) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const { error } = await ctx.supabase
      .from('access_roles')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('[DELETE /api/access-roles/[id]] delete error:', error);
      return NextResponse.json(
        { error: 'Failed to delete role' },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
