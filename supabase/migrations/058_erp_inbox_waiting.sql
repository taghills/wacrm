-- ============================================================
-- 058 — which conversations are waiting, and on what message
--
-- Migration 057's `awaiting_reply` counts every conversation whose
-- last message is the customer's. Most of those turned out to be
-- "ok", "thank you" or a 👍 — nothing to answer — so the ERP's red
-- "waiting for reply" badge stopped meaning anything.
--
-- Deciding "is this just an acknowledgement?" is a word list with
-- tests (src/lib/erp/acknowledgement.ts); it belongs in TypeScript,
-- not in a regex inside SQL that nobody would think to update. So
-- this function returns the waiting conversations WITH their last
-- message, and the route does the counting.
--
-- 057's function is left exactly as it is: the route still uses it
-- for `unread`, and falls back to its `awaiting_reply` if this
-- migration has not been applied yet.
--
-- Same security stance as 057: invoker rights, service role only.
-- ============================================================

CREATE OR REPLACE FUNCTION public.erp_inbox_waiting(
  p_account_id UUID,
  p_store_id UUID DEFAULT NULL
)
RETURNS TABLE (conversation_id UUID, content_type TEXT, content_text TEXT)
LANGUAGE sql
STABLE
AS $$
  WITH scoped AS (
    SELECT c.id
      FROM conversations c
     WHERE c.account_id = p_account_id
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
           m.sender_type,
           m.content_type,
           m.content_text
      FROM messages m
     WHERE m.conversation_id IN (SELECT id FROM scoped)
     ORDER BY m.conversation_id, m.created_at DESC, m.id DESC
  )
  -- The text is cut short: an acknowledgement is a few words, and the
  -- route has no business receiving whole customer messages.
  SELECT lm.conversation_id, lm.content_type, LEFT(lm.content_text, 120)
    FROM last_message lm
   WHERE lm.sender_type = 'customer';
$$;

REVOKE ALL ON FUNCTION public.erp_inbox_waiting(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erp_inbox_waiting(UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.erp_inbox_waiting(UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.erp_inbox_waiting(UUID, UUID) TO service_role;
