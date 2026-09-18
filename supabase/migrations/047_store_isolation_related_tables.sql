-- ============================================================
-- 047_store_isolation_related_tables.sql
--
-- Close three store-isolation leaks left by 043.
--
-- 043 made the customer the boundary and re-pointed the policies on
-- contacts, conversations, messages, contact_notes, contact_tags and
-- contact_custom_values. It missed every other table that carries a
-- contact_id, because those reach the customer by a different route
-- than "through the conversation" — which is the shape I checked.
--
-- Verified on a local Postgres 16 replica of the production schema,
-- seeded with two stores and one agent per store. The Shashtri Nagar
-- agent could NOT read the Bahadurgarh customer, their conversation
-- or their messages — but COULD read:
--
--   deals                 the deal title and its value
--   broadcast_recipients  which of that store's customers were sent
--                         a campaign, and the WhatsApp message id
--   flow_runs             that customer's active flow run
--
-- automation_logs has the same shape and the same account-only
-- policy; it is included here rather than left as the one remaining
-- instance of a class this migration exists to close.
--
-- ai_usage_log is deliberately NOT included: its policy is already
-- is_account_member(account_id, 'admin'), and admins are not
-- store-bound, so there is nothing to leak.
--
-- Two shapes, because contact_id is not nullable everywhere:
--
--   deals, broadcast_recipients  contact_id is NOT NULL, so the
--                                store rule applies unconditionally.
--   flow_runs, automation_logs   contact_id is nullable (ON DELETE
--                                SET NULL). A row whose contact is
--                                gone carries no customer identity,
--                                so it falls back to account
--                                membership rather than vanishing
--                                for everyone including the owner.
--
-- can_access_contact() (STABLE) is the right helper here, not 046's
-- can_access_contact_row(): these policies read `contacts` from a
-- different table than the one being written, so the row always
-- exists and the self-query problem 046 fixed cannot arise.
--
-- Idempotent — safe to run more than once.
-- ============================================================

-- ============================================================
-- DEALS — contact_id NOT NULL
-- ============================================================
DROP POLICY IF EXISTS deals_select ON deals;
DROP POLICY IF EXISTS deals_insert ON deals;
DROP POLICY IF EXISTS deals_update ON deals;
DROP POLICY IF EXISTS deals_delete ON deals;

CREATE POLICY deals_select ON deals FOR SELECT
  USING (can_access_contact(contact_id));
CREATE POLICY deals_insert ON deals FOR INSERT
  WITH CHECK (can_access_contact(contact_id, 'agent'));
CREATE POLICY deals_update ON deals FOR UPDATE
  USING (can_access_contact(contact_id, 'agent'))
  WITH CHECK (can_access_contact(contact_id, 'agent'));
CREATE POLICY deals_delete ON deals FOR DELETE
  USING (can_access_contact(contact_id, 'agent'));

-- ============================================================
-- BROADCAST_RECIPIENTS — contact_id NOT NULL
--
-- The broadcast itself stays account-scoped: an agent may see that a
-- campaign exists. What they may no longer see is which customers
-- outside their store it went to. Progress counts therefore reflect
-- the recipients that member can see, which is the honest number for
-- them rather than a total spanning stores they have no access to.
-- ============================================================
DROP POLICY IF EXISTS broadcast_recipients_select ON broadcast_recipients;
DROP POLICY IF EXISTS broadcast_recipients_modify ON broadcast_recipients;

CREATE POLICY broadcast_recipients_select ON broadcast_recipients FOR SELECT
  USING (can_access_contact(contact_id));
CREATE POLICY broadcast_recipients_modify ON broadcast_recipients FOR ALL
  USING (can_access_contact(contact_id, 'agent'))
  WITH CHECK (can_access_contact(contact_id, 'agent'));

-- ============================================================
-- FLOW_RUNS — contact_id nullable
-- ============================================================
DROP POLICY IF EXISTS flow_runs_select ON flow_runs;

CREATE POLICY flow_runs_select ON flow_runs FOR SELECT USING (
  CASE
    WHEN contact_id IS NULL THEN is_account_member(account_id)
    ELSE can_access_contact(contact_id)
  END
);

-- ============================================================
-- AUTOMATION_LOGS — contact_id nullable
-- ============================================================
DROP POLICY IF EXISTS automation_logs_select ON automation_logs;

CREATE POLICY automation_logs_select ON automation_logs FOR SELECT USING (
  CASE
    WHEN contact_id IS NULL THEN is_account_member(account_id)
    ELSE can_access_contact(contact_id)
  END
);
