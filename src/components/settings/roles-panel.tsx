'use client';

// ============================================================
// RolesPanel — Settings → Roles & access
//
// Build a named role, set each module to Hidden / View only /
// Full access, then assign it to staff from Team members.
//
// What this controls is rendering, not permission — the banner at
// the top says so in the admin's own words, because a screen full
// of Hidden toggles invites exactly the wrong assumption. The real
// limits are the account role plus the store rules, and those hold
// whatever is set here.
//
// Every toggle is clamped by the member's account role when it is
// applied (see resolveLevel): a role can take access away, never
// add it. Showing "Full access" on WhatsApp to an agent would only
// produce a form whose save the database refuses.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

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
import { cn } from '@/lib/utils';
import {
  ACCESS_LEVELS,
  ACCESS_MODULES,
  MODULE_META,
  type AccessLevel,
  type AccessModule,
  type AccessPermissions,
} from '@/lib/access/modules';

import { SettingsPanelHead } from './settings-panel-head';

interface AccessRole {
  id: string;
  name: string;
  permissions: AccessPermissions;
  created_at: string;
}

export function RolesPanel() {
  // 'Settings.accessRoles', not 'Settings.roles' — the latter holds
  // the account-role labels (Owner / Admin / Agent / Viewer) that
  // members-tab renders, and a second block under the same name
  // silently replaced them.
  const t = useTranslations('Settings.accessRoles');
  const canManage = useCan('edit-settings');

  const [loading, setLoading] = useState(true);
  const [roles, setRoles] = useState<AccessRole[]>([]);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AccessRole | null>(null);
  const [name, setName] = useState('');
  const [perms, setPerms] = useState<AccessPermissions>({});
  const [saving, setSaving] = useState(false);

  const [roleToDelete, setRoleToDelete] = useState<AccessRole | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/access-roles', { cache: 'no-store' });
      if (!res.ok) throw new Error('load failed');
      const json = (await res.json()) as { roles: AccessRole[] };
      setRoles(json.roles);
    } catch (err) {
      console.error('[roles] load error:', err);
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
    // A new role starts fully open; the admin removes what this role
    // should not see. Starting everything hidden would mean ticking
    // twenty boxes to build the common case.
    setPerms({});
    setFormOpen(true);
  }

  function openEdit(role: AccessRole) {
    setEditing(role);
    setName(role.name);
    setPerms(role.permissions ?? {});
    setFormOpen(true);
  }

  function setLevel(module: AccessModule, level: AccessLevel) {
    setPerms((prev) => ({ ...prev, [module]: level }));
  }

  async function handleSave() {
    if (!name.trim()) {
      toast.error(t('nameRequired'));
      return;
    }
    try {
      setSaving(true);
      const res = await fetch(
        editing ? `/api/access-roles/${editing.id}` : '/api/access-roles',
        {
          method: editing ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name.trim(), permissions: perms }),
        },
      );
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(json.error ?? t('saveFailed'));
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

  async function handleDelete() {
    if (!roleToDelete) return;
    try {
      setDeleting(true);
      const res = await fetch(`/api/access-roles/${roleToDelete.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        toast.error(t('deleteFailed'));
        return;
      }
      toast.success(t('deleted'));
      setRoleToDelete(null);
      await load();
    } finally {
      setDeleting(false);
    }
  }

  const workspaceModules = ACCESS_MODULES.filter(
    (m) => MODULE_META[m].group === 'workspace',
  );
  const settingsModules = ACCESS_MODULES.filter(
    (m) => MODULE_META[m].group === 'settings',
  );

  function renderGroup(title: string, modules: readonly AccessModule[]) {
    return (
      <div className="space-y-2">
        <p className="text-[11px] font-semibold tracking-[0.09em] text-muted-foreground uppercase">
          {title}
        </p>
        <div className="space-y-1">
          {modules.map((m) => {
            const current = perms[m] ?? 'edit';
            return (
              <div
                key={m}
                className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-muted/50"
              >
                <span className="min-w-0 truncate text-sm text-foreground">
                  {t(`modules.${m}`)}
                </span>
                <div className="flex shrink-0 gap-1">
                  {ACCESS_LEVELS.map((lvl) => (
                    <button
                      key={lvl}
                      type="button"
                      onClick={() => setLevel(m, lvl)}
                      className={cn(
                        'rounded-md border px-2 py-1 text-xs font-medium transition-colors',
                        current === lvl
                          ? 'border-primary/40 bg-primary/10 text-primary'
                          : 'border-border text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {t(`levels.${lvl}`)}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
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
              {t('newRole')}
            </Button>
          </RequireRole>
        }
      />

      <div className="mb-4 rounded-lg border border-border bg-muted/40 px-4 py-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t('scopeNote')}
        </p>
      </div>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : roles.length === 0 ? (
            <div className="px-6 py-12 text-center">
              <ShieldCheck className="mx-auto size-8 text-muted-foreground" />
              <p className="mt-3 text-sm font-medium text-foreground">
                {t('emptyTitle')}
              </p>
              <p className="mx-auto mt-1 max-w-[52ch] text-sm text-muted-foreground">
                {t('emptyDesc')}
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {roles.map((role) => {
                const hiddenCount = ACCESS_MODULES.filter(
                  (m) => role.permissions?.[m] === 'hidden',
                ).length;
                return (
                  <li
                    key={role.id}
                    className="flex items-center gap-3 px-4 py-3"
                  >
                    <ShieldCheck className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">
                        {role.name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t('hiddenCount', { count: hiddenCount })}
                      </p>
                    </div>
                    {canManage ? (
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openEdit(role)}
                        >
                          {t('edit')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t('delete')}
                          onClick={() => setRoleToDelete(role)}
                        >
                          <Trash2 className="size-4 text-destructive" />
                        </Button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
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
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? t('editRole') : t('newRole')}</DialogTitle>
            <DialogDescription>{t('formDesc')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="role-name">{t('nameLabel')}</Label>
              <Input
                id="role-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('namePlaceholder')}
                maxLength={60}
              />
            </div>

            {renderGroup(t('groupWorkspace'), workspaceModules)}
            {renderGroup(t('groupSettings'), settingsModules)}
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
        open={!!roleToDelete}
        onOpenChange={(open) => !open && setRoleToDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('deleteTitle')}</DialogTitle>
            <DialogDescription>
              {t('deleteDesc', { name: roleToDelete?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRoleToDelete(null)}>
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
