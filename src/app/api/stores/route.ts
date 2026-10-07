// ============================================================
// /api/stores
//
//   GET  — list the account's stores. Any member: the inbox
//          filter, the member picker and the contact panel all
//          need the names, and RLS (stores_select, migration 043)
//          already scopes the rows to the caller's account.
//   POST — create a store. Admin+.
//
// Authorization is RLS-first: `ctx.supabase` is the cookie-bound
// client, so a caller outside the account simply sees no rows and
// an INSERT for another account fails the policy. requireRole is
// the early, friendlier gate on top of that.
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

const NAME_MAX = 80;
const CODE_MAX = 16;
const PHONE_MAX = 32;
const REVIEW_URL_MAX = 500;

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    const { data, error } = await ctx.supabase
      .from('stores')
      .select('id, name, code, phone, review_url, active, created_at')
      .eq('account_id', ctx.accountId)
      .order('name', { ascending: true });

    if (error) {
      console.error('[GET /api/stores] fetch error:', error);
      return NextResponse.json(
        { error: 'Failed to load stores' },
        { status: 500 },
      );
    }

    return NextResponse.json({ stores: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:storeCreate:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      name?: unknown;
      code?: unknown;
      phone?: unknown;
      reviewUrl?: unknown;
    } | null;

    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const code = typeof body?.code === 'string' ? body.code.trim() : '';

    if (!name || name.length > NAME_MAX) {
      return NextResponse.json(
        { error: `'name' is required and must be at most ${NAME_MAX} characters` },
        { status: 400 },
      );
    }
    if (!code || code.length > CODE_MAX) {
      return NextResponse.json(
        { error: `'code' is required and must be at most ${CODE_MAX} characters` },
        { status: 400 },
      );
    }

    // Free-form: this is printed for a human to dial, never parsed
    // or matched, so the only check worth making is the length.
    // Blank normalises to NULL rather than an empty string, so
    // "unset" has one representation for the send path to test.
    const phoneRaw = typeof body?.phone === 'string' ? body.phone.trim() : '';
    if (phoneRaw.length > PHONE_MAX) {
      return NextResponse.json(
        { error: `'phone' must be at most ${PHONE_MAX} characters` },
        { status: 400 },
      );
    }

    // Google attaches reviews to a location, so each branch has its
    // own listing and its own link. https only: Meta refuses any
    // other scheme on a template's URL button, and a link the
    // customer cannot open is worse than no message.
    const reviewRaw =
      typeof body?.reviewUrl === 'string' ? body.reviewUrl.trim() : '';
    if (reviewRaw.length > REVIEW_URL_MAX) {
      return NextResponse.json(
        { error: `'reviewUrl' must be at most ${REVIEW_URL_MAX} characters` },
        { status: 400 },
      );
    }
    if (reviewRaw && !/^https:\/\/\S+$/i.test(reviewRaw)) {
      return NextResponse.json(
        { error: 'The review link must start with https://' },
        { status: 400 },
      );
    }

    const { data, error } = await ctx.supabase
      .from('stores')
      .insert({
        account_id: ctx.accountId,
        name,
        code,
        phone: phoneRaw || null,
        review_url: reviewRaw || null,
      })
      .select('id, name, code, phone, review_url, active, created_at')
      .single();

    if (error) {
      // idx_stores_account_code is UNIQUE on (account_id, lower(code)),
      // so a duplicate code is a user error, not a server fault.
      if (error.code === '23505') {
        return NextResponse.json(
          { error: 'A store with that code already exists' },
          { status: 409 },
        );
      }
      console.error('[POST /api/stores] insert error:', error);
      return NextResponse.json(
        { error: 'Failed to create store' },
        { status: 500 },
      );
    }

    return NextResponse.json({ store: data }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
