// ============================================================
// /api/contacts/[id]/stores
//
//   GET    — which stores this customer belongs to.
//   POST    — link the customer to a store.   Admin+.
//   DELETE — unlink the customer from a store. Admin+.
//
// contact_stores is the security boundary from migration 043:
// a link here is what lets that store's staff see the customer,
// their conversation and every message in it. So writes are
// admin+ only — `contact_stores_modify` enforces that in RLS too,
// and requireRole is the early gate. A store agent must not be
// able to attach a customer to their own branch, which would be a
// self-service grant of access.
//
// `source` is recorded as 'manual' here by definition: 'erp' is
// reserved for the sales-order sync and 'bot' for the customer's
// own branch pick, both of which write server-side.
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

async function readStoreId(request: Request): Promise<string | null> {
  const body = (await request.json().catch(() => null)) as {
    store_id?: unknown;
  } | null;
  return typeof body?.store_id === 'string' && body.store_id.trim()
    ? body.store_id.trim()
    : null;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await getCurrentAccount();
    const { id: contactId } = await params;

    // contact_stores_select gates on can_access_contact(), so a
    // caller who cannot see the customer gets an empty list rather
    // than a leak of which branches they belong to.
    const { data, error } = await ctx.supabase
      .from('contact_stores')
      .select('store_id, source, created_at, stores(id, name, code, active)')
      .eq('contact_id', contactId);

    if (error) {
      console.error('[GET /api/contacts/[id]/stores] fetch error:', error);
      return NextResponse.json(
        { error: 'Failed to load stores for contact' },
        { status: 500 },
      );
    }

    return NextResponse.json({ links: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:contactStore:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id: contactId } = await params;
    const storeId = await readStoreId(request);
    if (!storeId) {
      return NextResponse.json({ error: 'store_id required' }, { status: 400 });
    }

    const { error } = await ctx.supabase.from('contact_stores').insert({
      contact_id: contactId,
      store_id: storeId,
      account_id: ctx.accountId,
      source: 'manual',
    });

    if (error) {
      // Already linked — the PK is (contact_id, store_id). Treat as
      // success so a double-click is not an error the admin has to
      // think about.
      if (error.code === '23505') {
        return NextResponse.json({ ok: true, already: true });
      }
      // FK violation: the contact or the store is not in this
      // account, or RLS refused the row.
      if (error.code === '23503' || error.code === '42501') {
        return NextResponse.json(
          { error: 'Contact or store not found in your account' },
          { status: 404 },
        );
      }
      console.error('[POST /api/contacts/[id]/stores] insert error:', error);
      return NextResponse.json(
        { error: 'Failed to link store' },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:contactStore:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id: contactId } = await params;
    const storeId = await readStoreId(request);
    if (!storeId) {
      return NextResponse.json({ error: 'store_id required' }, { status: 400 });
    }

    const { error } = await ctx.supabase
      .from('contact_stores')
      .delete()
      .eq('contact_id', contactId)
      .eq('store_id', storeId);

    if (error) {
      console.error('[DELETE /api/contacts/[id]/stores] delete error:', error);
      return NextResponse.json(
        { error: 'Failed to unlink store' },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
