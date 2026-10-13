"use client";

// ============================================================
// Message activity — one list of every automatic message and what
// became of it.
//
// It exists because the answer was split in two and neither half
// was a screen. The inbox shows ticks inside ONE conversation, so
// "the customer says they got nothing" meant finding the contact and
// scrolling; and nothing at all answered "what failed today".
//
// What a staff member can see is the database's decision, not this
// page's: the route reads as the signed-in user, so an agent gets
// their own store's rows and an owner gets all four shops.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { formatDistanceToNow } from "date-fns";
import {
  AlertCircle,
  Check,
  CheckCheck,
  Eye,
  Loader2,
  MinusCircle,
  RefreshCw,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ACTIVITY_OUTCOMES,
  type ActivityEntry,
  type ActivityOutcome,
} from "@/lib/messages/activity";

interface ActivityResponse {
  entries: ActivityEntry[];
  counts: Record<ActivityOutcome, number>;
  truncated: boolean;
}

/** Icon and colour per outcome. Red for the two that need action. */
const OUTCOME_STYLE: Record<
  ActivityOutcome,
  { icon: typeof Check; className: string }
> = {
  failed: { icon: AlertCircle, className: "text-red-500" },
  not_sent: { icon: MinusCircle, className: "text-amber-500" },
  sent: { icon: Check, className: "text-muted-foreground" },
  delivered: { icon: CheckCheck, className: "text-muted-foreground" },
  read: { icon: Eye, className: "text-blue-500" },
};

/** Last 7 days. Older than that is a support question, not a shift. */
function defaultSince(): string {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString();
}

export default function MessageActivityPage() {
  const t = useTranslations("MessageActivity");
  const [data, setData] = useState<ActivityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [outcome, setOutcome] = useState<ActivityOutcome | null>(null);
  const [branch, setBranch] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ since: defaultSince() });
      if (outcome) params.set("outcome", outcome);
      if (branch) params.set("branch", branch);
      const res = await fetch(`/api/messages/activity?${params}`);
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error ?? "failed");
      setData(payload as ActivityResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("loadError"));
    } finally {
      setLoading(false);
    }
  }, [outcome, branch, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Branches come from the rows themselves rather than a stores
  // query: an agent must only be offered the branches they can
  // already see, and the rows are exactly that set.
  const branches = useMemo(() => {
    const seen = new Set<string>();
    for (const e of data?.entries ?? []) if (e.branch) seen.add(e.branch);
    return [...seen].sort();
  }, [data]);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-foreground">{t("title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("description")}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void load()}>
          <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          <span className="sr-only">{t("refresh")}</span>
        </Button>
      </div>

      {/* Counts first. The point of the screen is that "3 failed"
          is visible without reading anything. */}
      <div className="flex flex-wrap gap-2">
        {ACTIVITY_OUTCOMES.map((o) => {
          const { icon: Icon, className } = OUTCOME_STYLE[o];
          const active = outcome === o;
          return (
            <button
              key={o}
              type="button"
              onClick={() => setOutcome(active ? null : o)}
              aria-pressed={active}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition",
                active
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground hover:bg-muted",
              )}
            >
              <Icon className={cn("size-3.5", className)} />
              {t(`outcome.${o}`)}
              <span className="font-medium text-foreground">
                {data?.counts?.[o] ?? 0}
              </span>
            </button>
          );
        })}
      </div>

      {branches.length > 1 && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setBranch(null)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs transition",
              branch === null
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border text-muted-foreground hover:bg-muted",
            )}
          >
            {t("allBranches")}
          </button>
          {branches.map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => setBranch(branch === b ? null : b)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs transition",
                branch === b
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground hover:bg-muted",
              )}
            >
              {b}
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-900/40 bg-red-950/20 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {loading && !data ? (
        <div className="flex justify-center py-12">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : data && data.entries.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          {t("empty")}
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {data?.entries.map((entry) => {
            const { icon: Icon, className } = OUTCOME_STYLE[entry.outcome];
            return (
              <li key={entry.eventId} className="flex gap-3 px-4 py-3">
                <Icon className={cn("mt-0.5 size-4 shrink-0", className)} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="font-medium text-foreground">
                      {entry.contactName || t("unknownCustomer")}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {/* next-intl reads a dot as a path separator,
                          so the catalogue spells the event types
                          with an underscore. */}
                      {t(`event.${entry.eventType.replace(".", "_")}`)}
                    </span>
                    {entry.branch && (
                      <span className="text-xs text-muted-foreground">
                        · {entry.branch}
                      </span>
                    )}
                  </div>
                  {/* The reason is the whole point, so it is never
                      truncated or hidden behind a hover. */}
                  <p className="mt-0.5 break-words text-sm text-muted-foreground">
                    {entry.reason}
                  </p>
                </div>
                <time
                  className="shrink-0 text-xs text-muted-foreground"
                  dateTime={entry.receivedAt}
                >
                  {formatDistanceToNow(new Date(entry.receivedAt), {
                    addSuffix: true,
                  })}
                </time>
              </li>
            );
          })}
        </ul>
      )}

      {data?.truncated && (
        <p className="text-center text-xs text-muted-foreground">
          {t("truncated")}
        </p>
      )}
    </div>
  );
}
