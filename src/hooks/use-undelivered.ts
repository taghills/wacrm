"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

/**
 * Messages WhatsApp could not deliver ("Message undeliverable" and the
 * like — usually a number that is not on WhatsApp). Before this, the
 * only sign was a small red line under the message inside the chat, so
 * a failure went unnoticed unless someone happened to open that chat.
 *
 * Two readers:
 *  - the sidebar's red count on Message activity (`useUndeliveredCount`)
 *  - the inbox list's "Not delivered" mark (`useFailedMessages`)
 * Both look back REFRESH-ably over the last seven days and rely on RLS
 * for who sees what, like every other staff screen.
 */

const LOOKBACK_MS = 7 * 86_400_000;
const REFRESH_MS = 120_000;
const SEEN_KEY = "wacrm.undeliveredSeenAt";
const SEEN_EVENT = "wacrm:undelivered-seen";

function readSeen(): number {
  try {
    const v = Date.parse(localStorage.getItem(SEEN_KEY) ?? "");
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

/** Message activity was opened: the sidebar count starts again from now. */
export function markUndeliveredSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, new Date().toISOString());
  } catch {
    // storage blocked: the count just stays until the seven days pass
  }
  window.dispatchEvent(new Event(SEEN_EVENT));
}

/**
 * ERP messages (the automatic ones on Message activity) that WhatsApp
 * could not deliver since Message activity was last opened, within
 * the last seven days.
 */
export function useUndeliveredCount(): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    const load = async () => {
      const since = new Date(Math.max(Date.now() - LOOKBACK_MS, readSeen())).toISOString();
      const { count: n, error } = await supabase
        .from("erp_events")
        .select("event_id, messages!inner(status)", { count: "exact", head: true })
        .eq("messages.status", "failed")
        .gte("received_at", since);
      if (!cancelled && !error) setCount(n ?? 0);
    };

    load();
    const timer = setInterval(load, REFRESH_MS);
    const onSeen = () => setCount(0);
    window.addEventListener(SEEN_EVENT, onSeen);
    window.addEventListener("focus", load);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener(SEEN_EVENT, onSeen);
      window.removeEventListener("focus", load);
    };
  }, []);

  return count;
}

export interface FailedMessage {
  conversation_id: string;
  created_at: string;
}

/** Messages that failed in the last seven days (any kind), refreshed every two minutes. */
export function useFailedMessages(resyncToken = 0): FailedMessage[] {
  const [rows, setRows] = useState<FailedMessage[]>([]);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    const load = async () => {
      const { data, error } = await supabase
        .from("messages")
        .select("conversation_id, created_at")
        .eq("status", "failed")
        .gte("created_at", new Date(Date.now() - LOOKBACK_MS).toISOString())
        .order("created_at", { ascending: false })
        .limit(500);
      if (!cancelled && !error) setRows((data ?? []) as FailedMessage[]);
    };

    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [resyncToken]);

  return rows;
}

/**
 * Conversations whose LATEST message is one WhatsApp could not deliver.
 * A failure followed by a newer message (a resend to the corrected
 * number, or the customer writing back) no longer counts.
 */
export function undeliveredConversations(
  failed: FailedMessage[],
  conversations: { id: string; last_message_at?: string }[],
): Set<string> {
  const lastAt = new Map(conversations.map((c) => [c.id, c.last_message_at ? Date.parse(c.last_message_at) : 0]));
  const out = new Set<string>();
  for (const m of failed) {
    const last = lastAt.get(m.conversation_id);
    if (last === undefined) continue;
    // last_message_at is set when the message is stored; 5 s covers clock and write order
    if (Date.parse(m.created_at) >= last - 5_000) out.add(m.conversation_id);
  }
  return out;
}
