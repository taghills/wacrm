'use client';

// ============================================================
// StoresPanel — Settings → Stores
//
// The account's physical retail locations. A store is not a label:
// migration 043 makes it the authorization boundary, so the rows
// edited here decide which customers each staff member can see.
// That is why the copy below is blunt about consequences, and why
// deleting asks for confirmation.
//
// Reads are open to any member (the roster, the contact panel and
// the member picker all need the names). Writes are admin+, gated
// both here with `<RequireRole min="admin">` and server-side by
// the route + the `stores_*` policies.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Pencil, Plus, Store as StoreIcon, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RequireRole } from '@/components/auth/require-role';
import { useCan } from '@/hooks/use-can';
import type { Store } from '@/types';

import { SettingsPanelHead } from './settings-panel-head';

export function StoresPanel() {
  const t = useTranslations('Settings.stores');
  const canManage = useCan('edit-settings');

  const [loading, setLoading] = useState(true);
  const [stores, setStores] = useState<Store[]>([]);

  // One dialog serves both create and edit. `editing` is the store
  // being renamed, or null for a fresh one — that way the field
  // limits and validation can't drift between the two paths.
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Store | null>(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [saving, setSaving] = useState(false);

  const [storeToDelete, setStoreToDelete] = useState<Store | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/stores', { cache: 'no-store' });
      if (!res.ok) throw new Error('load failed');
      const json = (await res.json()) as { stores: Store[] };
      setStores(json.stores);
    } catch (err) {
      console.error('[stores] load error:', err);
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreate() {
    setEditing(null);
    setName('');
    setCode('');
    setFormOpen(true);
  }

  function openEdit(store: Store) {
    setEditing(store);
    setName(store.name);
    setCode(store.code);
    setFormOpen(true);
  }

  async function handleSave() {
    if (!name.trim() || !code.trim()) {
      toast.error(t('nameAndCodeRequired'));
      return;
    }
    try {
      setSaving(true);
      const res = await fetch(
        editing ? `/api/stores/${editing.id}` : '/api/stores',
        {
          method: editing ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name.trim(), code: code.trim() }),
        },
      );
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        // The route maps a duplicate code to 409 with a specific
        // message; surface that rather than the generic fallback.
        toast.error(json.error ?? (editing ? t('updateFailed') : t('createFailed')));
        return;
      }
      toast.success(editing ? t('updated') : t('created'));
      setFormOpen(false);
      setEditing(null);
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleActive(store: Store) {
    const res = await fetch(`/api/stores/${store.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: !store.active }),
    });
    if (!res.ok) {
      toast.error(t('updateFailed'));
      return;
    }
    await load();
  }

  async function handleDelete() {
    if (!storeToDelete) return;
    try {
      setDeleting(true);
      const res = await fetch(`/api/stores/${storeToDelete.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        toast.error(t('deleteFailed'));
        return;
      }
      toast.success(t('deleted'));
      setStoreToDelete(null);
      await load();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div>
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={
          <RequireRole min="admin">
            <Button size="sm" onClick={openCreate}>
              <Plus className="mr-1.5 size-4" />
              {t('newStore')}
            </Button>
          </RequireRole>
        }
      />

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : stores.length === 0 ? (
            <div className="px-6 py-12 text-center">
              <StoreIcon className="mx-auto size-8 text-muted-foreground" />
              <p className="mt-3 text-sm font-medium text-foreground">
                {t('emptyTitle')}
              </p>
              <p className="mx-auto mt-1 max-w-[52ch] text-sm text-muted-foreground">
                {t('emptyDesc')}
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {stores.map((store) => (
                <li
                  key={store.id}
                  className="flex items-center gap-3 px-4 py-3"
                >
                  <StoreIcon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {store.name}
                      </span>
                      <Badge variant="secondary" className="font-mono text-xs">
                        {store.code}
                      </Badge>
                      {!store.active ? (
                        <Badge variant="outline" className="text-xs">
                          {t('inactive')}
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                  {canManage ? (
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t('edit')}
                        onClick={() => openEdit(store)}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleToggleActive(store)}
                      >
                        {store.active ? t('deactivate') : t('activate')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t('delete')}
                        onClick={() => setStoreToDelete(store)}
                      >
                        <Trash2 className="size-4 text-destructive" />
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) setEditing(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editing ? t('editStore') : t('newStore')}
            </DialogTitle>
            <DialogDescription>
              {editing ? t('editStoreDesc') : t('newStoreDesc')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="store-name">{t('nameLabel')}</Label>
              <Input
                id="store-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('namePlaceholder')}
                maxLength={80}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="store-code">{t('codeLabel')}</Label>
              <Input
                id="store-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={t('codePlaceholder')}
                maxLength={16}
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">{t('codeHelp')}</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)}>
              {t('cancel')}
            </Button>
            <Button onClick={() => void handleSave()} disabled={saving}>
              {saving ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
              {editing ? t('save') : t('create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!storeToDelete}
        onOpenChange={(open) => !open && setStoreToDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('deleteTitle')}</DialogTitle>
            <DialogDescription>
              {t('deleteDesc', { name: storeToDelete?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStoreToDelete(null)}>
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleDelete()}
              disabled={deleting}
            >
              {deleting ? (
                <Loader2 className="mr-1.5 size-4 animate-spin" />
              ) : null}
              {t('delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
