// ============================================================
// PUT /api/account/members/[userId]/access-role
//
// Assign a UI access role to a member, or clear it with null so
// they fall back to the defaults for their account_role. Admin+.
//
// Delegates to set_member_access_role (migration 045): profiles
// .access_role_id is guarded by 034's trigger, so a direct write
// from the browser is refused by design.
// ============================================================

import { NextResponse } from 'next/server';
import type { PostgrestError } from '@supabase/supabase-js';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

function rpcErrorToResponse(err: PostgrestError): NextResponse {
  if (err.code === '42501') {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  if (err.code === '22023') {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  console.error('[member access-role route] unexpected RPC error:', err);
  return NextResponse.json({ error: 'Failed to update role' }, { status: 500 });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:memberAccessRole:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { userId } = await params;

    const body = (await request.json().catch(() => null)) as {
      access_role_id?: unknown;
    } | null;

    // null is meaningful (clear the role), so distinguish it from a
    // missing key rather than coercing both.
    if (body === null || !('access_role_id' in body)) {
      return NextResponse.json(
        { error: "'access_role_id' is required (use null to clear)" },
        { status: 400 },
      );
    }

    const raw = body.access_role_id;
    if (raw !== null && typeof raw !== 'string') {
      return NextResponse.json(
        { error: "'access_role_id' must be a string or null" },
        { status: 400 },
      );
    }

    const roleId = typeof raw === 'string' && raw.trim() ? raw.trim() : null;

    const { error } = await ctx.supabase.rpc('set_member_access_role', {
      p_user_id: userId,
      p_access_role_id: roleId,
    });

    if (error) return rpcErrorToResponse(error);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
