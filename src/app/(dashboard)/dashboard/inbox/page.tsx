// ============================================================
// /dashboard/inbox?phone=<digits> — open a customer's chat by phone
// number.
//
// This is the ERP's "💬 WhatsApp chat" button. It knows a phone
// number, never a CRM conversation id, so this page does the
// translation: find (or start) the conversation for that number and
// hand off to the real inbox at /inbox?c=<id>.
//
// Why the path is /dashboard/inbox and not /inbox
//
//   The inbox lives at /inbox — `(dashboard)` is a route GROUP, so
//   it contributes nothing to the URL. The ERP is already deployed
//   and links to /dashboard/inbox, so this page exists at the path
//   the ERP actually uses rather than asking a finished, deployed
//   system to change. It is a redirect, not a second inbox: there is
//   still exactly one inbox implementation.
//
// Resolution runs on the server, under the signed-in user's own RLS
// client, so store isolation applies exactly as it does everywhere
// else — a staff member who may not see a customer cannot reach
// their chat by guessing the phone number in the query string.
// ============================================================

import { redirect } from "next/navigation";

import { getCurrentAccount } from "@/lib/auth/account";
import { resolveConversationByPhone } from "@/lib/whatsapp/resolve-conversation";
import { sanitizePhoneForMeta, isValidE164 } from "@/lib/whatsapp/phone-utils";

export default async function DashboardInboxRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params.phone;
  const phone = sanitizePhoneForMeta(
    typeof raw === "string" ? raw : Array.isArray(raw) ? (raw[0] ?? "") : "",
  );

  // No (or unusable) phone: just show the inbox. Better than an
  // error page for someone who landed here from a stale bookmark.
  if (!phone || !isValidE164(phone)) {
    redirect("/inbox");
  }

  const { supabase, accountId } = await getCurrentAccount();

  let conversationId: string;
  try {
    ({ conversationId } = await resolveConversationByPhone(
      supabase,
      accountId,
      phone,
    ));
  } catch (error) {
    // The usual causes are "WhatsApp is not connected yet" and a
    // contact this user's store may not see. Neither is worth an
    // error screen inside the ERP's iframe — land them on the inbox,
    // which explains its own state.
    console.warn("[dashboard/inbox] could not resolve", phone, error);
    redirect("/inbox");
  }

  redirect(`/inbox?c=${encodeURIComponent(conversationId)}`);
}
