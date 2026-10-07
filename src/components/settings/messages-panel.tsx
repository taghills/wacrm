'use client';

// ============================================================
// MessagesPanel — Settings → Automatic messages
//
// Two values that used to need a developer: the Google review link
// (a hosting environment variable, invisible here, needing a
// redeploy to change) and the delay before the review request goes
// out (which did not exist — the CRM waited for the ERP to decide,
// and the ERP never built it).
//
// Reads are open to any member: the review link is a public Google
// page, and the send path needs it. Writes are admin+, gated here
// with `<RequireRole min="admin">` and server-side by the route and
// the `message_settings_*` policies.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RequireRole } from '@/components/auth/require-role';
import { useCan } from '@/hooks/use-can';

import { SettingsPanelHead } from './settings-panel-head';

interface MessageSettingsResponse {
  reviewUrl: string | null;
  reviewDelayDays: number;
  reviewUrlSource: 'settings' | 'env' | 'unset';
  maxDelayDays: number;
  defaultDelayDays: number;
}

export function MessagesPanel() {
  const t = useTranslations('Settings.messages');
  const canManage = useCan('edit-settings');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reviewUrl, setReviewUrl] = useState('');
  const [delayDays, setDelayDays] = useState('3');
  const [source, setSource] = useState<MessageSettingsResponse['reviewUrlSource']>('unset');
  const [maxDelay, setMaxDelay] = useState(90);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/settings/messages');
      if (!res.ok) throw new Error('load failed');
      const data = (await res.json()) as MessageSettingsResponse;
      setReviewUrl(data.reviewUrl ?? '');
      setDelayDays(String(data.reviewDelayDays));
      setSource(data.reviewUrlSource);
      setMaxDelay(data.maxDelayDays);
    } catch {
      toast.error(t('loadError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    const days = Number(delayDays);
    // Checked here as well as server-side so the common mistake gets
    // an answer without a round trip.
    if (!Number.isInteger(days) || days < 0 || days > maxDelay) {
      toast.error(t('delayInvalid', { max: maxDelay }));
      return;
    }
    const url = reviewUrl.trim();
    if (url && !/^https:\/\//i.test(url)) {
      toast.error(t('urlInvalid'));
      return;
    }

    setSaving(true);
    try {
      const res = await fetch('/api/settings/messages', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewUrl: url, reviewDelayDays: days }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'save failed');
      setSource(data.reviewUrlSource);
      toast.success(t('saved'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveError'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <Card>
          <CardContent className="space-y-6 pt-6">
            <div className="space-y-2">
              <Label htmlFor="review-url">{t('reviewUrlLabel')}</Label>
              <Input
                id="review-url"
                type="url"
                inputMode="url"
                placeholder={t('reviewUrlPlaceholder')}
                value={reviewUrl}
                onChange={(e) => setReviewUrl(e.target.value)}
                disabled={!canManage || saving}
              />
              <p className="text-sm text-muted-foreground">
                {t('reviewUrlHelp')}
              </p>
              {/* Worth saying out loud: the value is currently coming
                  from the old hosting variable, and saving here takes
                  over from it for good. */}
              {source === 'env' && (
                <p className="text-sm text-amber-600 dark:text-amber-500">
                  {t('reviewUrlFromEnv')}
                </p>
              )}
              {source === 'unset' && (
                <p className="text-sm text-amber-600 dark:text-amber-500">
                  {t('reviewUrlUnset')}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="review-delay">{t('delayLabel')}</Label>
              <Input
                id="review-delay"
                type="number"
                min={0}
                max={maxDelay}
                step={1}
                className="max-w-32"
                value={delayDays}
                onChange={(e) => setDelayDays(e.target.value)}
                disabled={!canManage || saving}
              />
              <p className="text-sm text-muted-foreground">
                {t('delayHelp', { max: maxDelay })}
              </p>
            </div>

            <RequireRole min="admin">
              <div className="flex items-center gap-3">
                <Button onClick={save} disabled={saving}>
                  {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {t('save')}
                </Button>
              </div>
            </RequireRole>

            <p className="border-l-2 border-muted pl-3 text-sm text-muted-foreground">
              {t('scheduleNote')}
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
