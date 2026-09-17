// ============================================================
// PUT /api/account/members/[userId]/store
//
// Assign a team member to a store, or un-assign them with a null
// store_id. Admin+.
//
// A separate route rather than a field on the sibling PATCH: that
// handler requires a `role` and delegates to set_member_role, and
// store assignment is a different privilege with its own RPC.
//
// Delegates to set_member_store (migration 044), which does the
// real authorization — admin+, same account, store in that account,
// no self-assignment. It has to be an RPC: migration 043 made
// profiles.store_id a privilege column, so 034's trigger refuses a
// direct write from the `authenticated` role.
//
// Un-assigning is deliberately allowed to leave the member seeing
// nothing (the fail-closed default from 043), so the UI confirms
// before sending null.
// ============================================================

import { NextResponse } from 'next/server';
import type { PostgrestError } from '@supabase/supabase-js';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

// Same SQLSTATE mapping the sibling members route uses: 42501 is
// the RPC refusing on authorization, 22023 on a bad argument.
function rpcErrorToResponse(err: PostgrestError): NextResponse {
  if (err.code === '42501') {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  if (err.code === '22023') {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  console.error('[member store route] unexpected RPC error:', err);
  return NextResponse.json(
    { error: 'Failed to update store' },
    { status: 500 },
  );
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:memberStore:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { userId } = await params;

    const body = (await request.json().catch(() => null)) as {
      store_id?: unknown;
    } | null;

    // `null` is meaningful (un-assign), so distinguish it from a
    // missing key rather than coercing both to null.
    if (body === null || !('store_id' in body)) {
      return NextResponse.json(
        { error: "'store_id' is required (use null to un-assign)" },
        { status: 400 },
      );
    }

    const raw = body.store_id;
    if (raw !== null && typeof raw !== 'string') {
      return NextResponse.json(
        { error: "'store_id' must be a string or null" },
        { status: 400 },
      );
    }

    const storeId = typeof raw === 'string' && raw.trim() ? raw.trim() : null;

    const { error } = await ctx.supabase.rpc('set_member_store', {
      p_user_id: userId,
      p_store_id: storeId,
    });

    if (error) return rpcErrorToResponse(error);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
