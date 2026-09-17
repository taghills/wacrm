// ============================================================
// /api/stores/[id]
//
//   PATCH  — rename a store, change its code, or deactivate it.
//   DELETE — remove a store.
//
// Both admin+. Deleting cascades: migration 043 declares
// contact_stores.store_id and profiles.store_id as ON DELETE
// CASCADE / SET NULL respectively, so removing a store detaches
// its customers and un-assigns its staff rather than orphaning
// rows. Staff left with a NULL store see nothing until they are
// re-assigned — the fail-closed default from 043 — so the UI
// warns before calling this.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

const NAME_MAX = 80;
const CODE_MAX = 16;

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:storeUpdate:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    const body = (await request.json().catch(() => null)) as {
      name?: unknown;
      code?: unknown;
      active?: unknown;
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

    if (body?.code !== undefined) {
      const code = typeof body.code === 'string' ? body.code.trim() : '';
      if (!code || code.length > CODE_MAX) {
        return NextResponse.json(
          { error: `'code' must be 1-${CODE_MAX} characters` },
          { status: 400 },
        );
      }
      patch.code = code;
    }

    if (body?.active !== undefined) {
      if (typeof body.active !== 'boolean') {
        return NextResponse.json(
          { error: "'active' must be a boolean" },
          { status: 400 },
        );
      }
      patch.active = body.active;
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json(
        { error: 'Nothing to update' },
        { status: 400 },
      );
    }

    // No .eq('account_id') needed — stores_update RLS already
    // constrains the row to the caller's account, and a miss
    // returns zero rows rather than touching someone else's.
    const { data, error } = await ctx.supabase
      .from('stores')
      .update(patch)
      .eq('id', id)
      .select('id, name, code, active, created_at')
      .maybeSingle();

    if (error) {
      if (error.code === '23505') {
        return NextResponse.json(
          { error: 'A store with that code already exists' },
          { status: 409 },
        );
      }
      console.error('[PATCH /api/stores/[id]] update error:', error);
      return NextResponse.json(
        { error: 'Failed to update store' },
        { status: 500 },
      );
    }

    if (!data) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    return NextResponse.json({ store: data });
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
      `admin:storeDelete:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;

    // Read first so a delete that RLS filtered out reports 404
    // rather than a misleading success — DELETE reports no rows
    // either way.
    const { data: existing } = await ctx.supabase
      .from('stores')
      .select('id')
      .eq('id', id)
      .maybeSingle();

    if (!existing) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const { error } = await ctx.supabase.from('stores').delete().eq('id', id);

    if (error) {
      console.error('[DELETE /api/stores/[id]] delete error:', error);
      return NextResponse.json(
        { error: 'Failed to delete store' },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
