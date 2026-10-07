// ============================================================
// /api/settings/messages
//
//   GET — read the account's message settings. Any member: the
//         send path and the settings screen both need them, and
//         the review link is a public Google page, not a secret.
//   PUT — change them. Admin+.
//
// These two values used to live in REVIEW_LINK_URL, a hosting
// environment variable: invisible in the app, editable by one
// person, and changeable only with a redeploy. The delay did not
// exist at all.
// ============================================================

import { NextResponse } from 'next/server';

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import {
  clampDelay,
  DEFAULT_REVIEW_DELAY_DAYS,
  MAX_REVIEW_DELAY_DAYS,
  normalizeUrl,
  resolveMessageSettings,
} from '@/lib/erp/message-settings';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

const URL_MAX = 500;

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const settings = await resolveMessageSettings(ctx.supabase, ctx.accountId);

    return NextResponse.json({
      reviewUrl: settings.reviewUrl,
      reviewDelayDays: settings.reviewDelayDays,
      /**
       * 'env' means the value still comes from the old hosting
       * variable. The screen says so, because editing the field
       * then moves it into the database and the variable stops
       * mattering — worth knowing before you wonder why the
       * variable no longer has any effect.
       */
      reviewUrlSource: settings.reviewUrlSource,
      maxDelayDays: MAX_REVIEW_DELAY_DAYS,
      defaultDelayDays: DEFAULT_REVIEW_DELAY_DAYS,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:messageSettings:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      reviewUrl?: unknown;
      reviewDelayDays?: unknown;
    } | null;

    const patch: Record<string, unknown> = { account_id: ctx.accountId };

    if (body?.reviewUrl !== undefined) {
      const raw = typeof body.reviewUrl === 'string' ? body.reviewUrl.trim() : '';
      if (raw.length > URL_MAX) {
        return NextResponse.json(
          { error: `'reviewUrl' must be at most ${URL_MAX} characters` },
          { status: 400 },
        );
      }
      // Clearing it is a legitimate edit. A non-empty value that is
      // not an https URL is rejected rather than silently dropped:
      // Meta refuses anything else on a button, and a link the
      // customer cannot open is worse than no message.
      if (raw && !normalizeUrl(raw)) {
        return NextResponse.json(
          { error: 'The review link must start with https://' },
          { status: 400 },
        );
      }
      patch.review_url = raw || null;
    }

    if (body?.reviewDelayDays !== undefined) {
      const raw = Number(body.reviewDelayDays);
      if (!Number.isInteger(raw) || raw < 0 || raw > MAX_REVIEW_DELAY_DAYS) {
        return NextResponse.json(
          { error: `'reviewDelayDays' must be a whole number from 0 to ${MAX_REVIEW_DELAY_DAYS}` },
          { status: 400 },
        );
      }
      patch.review_delay_days = clampDelay(raw);
    }

    if (Object.keys(patch).length === 1) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
    }

    // Upsert on account_id: the row does not exist until someone
    // saves for the first time, and an account with no row is the
    // normal state, not an error.
    const { data, error } = await ctx.supabase
      .from('message_settings')
      .upsert(patch, { onConflict: 'account_id' })
      .select('review_url, review_delay_days')
      .single();

    if (error) {
      console.error('[PUT /api/settings/messages] upsert error:', error);
      return NextResponse.json(
        { error: 'Failed to save settings' },
        { status: 500 },
      );
    }

    return NextResponse.json({
      reviewUrl: data.review_url,
      reviewDelayDays: data.review_delay_days,
      reviewUrlSource: data.review_url ? 'settings' : 'unset',
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
