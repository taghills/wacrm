-- ============================================================
-- 054: the GRANTs migration 052 forgot
--
-- RLS decides WHICH ROWS a role may touch. It does not grant the
-- right to touch the table at all — that is a separate GRANT, and
-- migration 048 says so in its own header: "New tables must still
-- carry their own GRANT in their own migration."
--
-- 052 created message_settings and erp_review_queue and granted only
-- to service_role. So the ERP endpoints (service role) worked, the
-- policies looked right, and Settings -> Automatic messages failed to
-- save with "permission denied for table message_settings" the first
-- time anyone tried.
--
-- The read hid half of it: resolveMessageSettings catches its error,
-- logs a warning and returns the defaults, so the screen loaded
-- looking healthy and only the save failed. That is deliberate — a
-- review setting must never break an order confirmation — but it
-- meant the gap surfaced as a mysterious toast rather than a clear
-- error.
--
-- Privileges mirror the policies exactly, per 048's rule:
--   FOR SELECT policy -> GRANT SELECT, and so on.
-- ============================================================

-- message_settings: members read (the send path needs it, and a
-- review link is a public Google page), admins write. The policies
-- are already in 052; these are the privileges they assume.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE message_settings TO authenticated;

-- erp_review_queue: admin-only SELECT, and read-only. Every write
-- comes from the service role, which bypasses RLS, so authenticated
-- gets SELECT and nothing more.
GRANT SELECT ON TABLE erp_review_queue TO authenticated;

-- Deliberately nothing for anon, matching 048: an unauthenticated
-- caller has no business reading either table.
