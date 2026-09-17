'use client';

// ============================================================
// ContactStoresCard — which stores a customer belongs to.
//
// This is not a label picker. contact_stores (migration 043) is the
// authorization boundary: adding a store here is what lets that
// store's staff read this customer, their conversation and every
// message in it. Removing the last one hides the customer from
// everyone except owner/admin.
//
// So: writes are admin+ (enforced by the route and by
// contact_stores_modify in RLS — the chips are read-only for
// agents), and the copy says what the toggle actually does.
//
// Links created by the ERP sync or the branch-picker bot show their
// origin, because "who decided this" matters when an admin is
// deciding whether to undo it.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Check, Loader2, Store as StoreIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useCan } from '@/hooks/use-can';
import { cn } from '@/lib/utils';
import type { ContactStoreLink, Store } from '@/types';

export function ContactStoresCard({ contactId }: { contactId: string }) {
  const t = useTranslations('Contacts.stores');
  const canManage = useCan('manage-members');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [stores, setStores] = useState<Store[]>([]);
  const [links, setLinks] = useState<ContactStoreLink[]>([]);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [sres, lres] = await Promise.all([
        fetch('/api/stores', { cache: 'no-store' }),
        fetch(`/api/contacts/${contactId}/stores`, { cache: 'no-store' }),
      ]);
      if (sres.ok) {
        const sdata = (await sres.json()) as { stores: Store[] };
        setStores(sdata.stores);
      }
      if (lres.ok) {
        const ldata = (await lres.json()) as { links: ContactStoreLink[] };
        setLinks(ldata.links);
      }
    } catch (err) {
      console.error('[contact stores] load error:', err);
    } finally {
      setLoading(false);
    }
  }, [contactId]);

  useEffect(() => {
    void load();
  }, [load]);

  const linkedIds = new Set(links.map((l) => l.store_id));

  async function toggle(store: Store) {
    const linked = linkedIds.has(store.id);
    setSaving(store.id);
    try {
      const res = await fetch(`/api/contacts/${contactId}/stores`, {
        method: linked ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ store_id: store.id }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        toast.error(payload.error ?? t('updateFailed'));
        return;
      }
      await load();
    } catch (err) {
      console.error('[contact stores] toggle error:', err);
      toast.error(t('updateFailed'));
    } finally {
      setSaving(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        {t('loading')}
      </div>
    );
  }

  const active = stores.filter((s) => s.active || linkedIds.has(s.id));

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <StoreIcon className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium text-foreground">
          {t('title')}
        </span>
      </div>

      {active.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('noStoresYet')}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {active.map((store) => {
            const linked = linkedIds.has(store.id);
            const link = links.find((l) => l.store_id === store.id);
            const busy = saving === store.id;
            return (
              <button
                key={store.id}
                type="button"
                disabled={!canManage || busy}
                onClick={() => void toggle(store)}
                title={
                  link
                    ? t(`source.${link.source}`)
                    : canManage
                      ? t('clickToLink')
                      : undefined
                }
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-all',
                  linked
                    ? 'border-primary/40 bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground opacity-60',
                  canManage ? 'cursor-pointer hover:opacity-100' : 'cursor-default',
                )}
              >
                {busy ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : linked ? (
                  <Check className="size-3" />
                ) : null}
                {store.name}
              </button>
            );
          })}
        </div>
      )}

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {linkedIds.size === 0 ? t('unassignedHelp') : t('assignedHelp')}
      </p>
    </div>
  );
}
