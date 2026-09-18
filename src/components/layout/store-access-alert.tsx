"use client";

import { useTranslations } from "next-intl";
import { Store as StoreIcon } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";

/**
 * Tells a store-bound member that they have no store yet.
 *
 * Same failure shape as AccountAccessAlert and the same reason for
 * existing: migration 043 makes an agent or viewer with a NULL
 * store_id match no customer at all. That is the correct,
 * fail-closed answer — "unset" must never widen to "every store" —
 * but on screen it is indistinguishable from a broken app. The
 * inbox is empty, Contacts is empty, and creating a contact fails
 * with "Failed to save contact" and no reason, because the new row
 * cannot be read back through a policy the member satisfies for
 * nothing.
 *
 * Owner and admin are never store-bound, so they never see this.
 *
 * Renders nothing on the happy path.
 */
export function StoreAccessAlert() {
  const { accountStatus, accountRole, profile } = useAuth();
  const t = useTranslations("StoreAccess");

  // Wait for the account context to settle, and stay quiet when it
  // failed — AccountAccessAlert is already explaining that, and two
  // stacked alerts about the same broken state help nobody.
  if (accountStatus !== "ready") return null;
  if (!accountRole || accountRole === "owner" || accountRole === "admin") {
    return null;
  }
  if (profile?.store_id) return null;

  return (
    <Alert className="mb-4">
      <StoreIcon />
      <AlertTitle>{t("title")}</AlertTitle>
      <AlertDescription>{t("body")}</AlertDescription>
    </Alert>
  );
}
