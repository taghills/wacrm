-- ============================================================
-- 057 — inbox counts for the ERP's till screen
--
-- The ERP wants to show each shop "how many customers are waiting
-- on us", next to the chat link it already has. Two numbers, both
-- optionally scoped to one branch:
--
--   unread          conversations with an unopened incoming message
--   awaiting_reply  conversations whose LAST message is the customer's
--
-- They are deliberately not the same number. A conversation read by
-- staff and then left unanswered has unread_count = 0 and is still
-- waiting — and that is precisely the one that gets forgotten,
-- because nothing in the inbox is bold any more.
--
-- Why a function rather than two PostgREST queries: "the last
-- message in each conversation" needs DISTINCT ON, which PostgREST
-- cannot express. The alternative was one query per conversation,
-- which on a shop with a thousand threads is a thousand round trips
-- for a number shown on a dashboard.
--
-- Invoker rights on purpose, unlike migration 037's functions. The
-- only caller is the ERP route, which already holds the service
-- role and bypasses RLS anyway. Leaving this SECURITY INVOKER means
-- that if someone ever grants EXECUTE more widely, RLS still
-- applies and the function cannot be turned into a way to count
-- another tenant's conversations by passing their account id.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created_at
  ON messages (conversation_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.erp_inbox_counts(
  p_account_id UUID,
  p_store_id UUID DEFAULT NULL
)
RETURNS TABLE (unread BIGINT, awaiting_reply BIGINT)
LANGUAGE sql
STABLE
AS $$
  WITH scoped AS (
    SELECT c.id, c.unread_count
      FROM conversations c
     WHERE c.account_id = p_account_id
       -- A null store means the whole account: the ERP asks that way
       -- for the owner's overview, and per-branch for a till.
       AND (
         p_store_id IS NULL
         OR EXISTS (
           SELECT 1
             FROM contact_stores cs
            WHERE cs.contact_id = c.contact_id
              AND cs.store_id   = p_store_id
         )
       )
  ),
  last_message AS (
    SELECT DISTINCT ON (m.conversation_id)
           m.conversation_id,
           m.sender_type
      FROM messages m
     WHERE m.conversation_id IN (SELECT id FROM scoped)
     -- id breaks the tie so two messages stored in the same second
     -- resolve the same way on every call, rather than the count
     -- flickering between refreshes.
     ORDER BY m.conversation_id, m.created_at DESC, m.id DESC
  )
  SELECT
    (SELECT COUNT(*) FROM scoped WHERE COALESCE(unread_count, 0) > 0),
    (SELECT COUNT(*) FROM last_message WHERE sender_type = 'customer');
$$;

-- Only the ERP route calls this, through the service role. Lock
-- everyone else out rather than relying on the argument being a
-- tenant's own account id.
REVOKE ALL ON FUNCTION public.erp_inbox_counts(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erp_inbox_counts(UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.erp_inbox_counts(UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.erp_inbox_counts(UUID, UUID) TO service_role;
