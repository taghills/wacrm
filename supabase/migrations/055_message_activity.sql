-- ============================================================
-- 055_message_activity.sql — one screen for "what happened to that
-- customer's message?"
--
-- The answer already existed, in two halves that never met:
--
--   erp_events  WHY the CRM did or did not send — held back by the
--               rollout gate, store with no phone number, branch
--               matching no store, template not approved.
--   messages    what META did once it was sent — sent, delivered,
--               read, failed, with Meta's own reason.
--
-- Nothing joined them, so a staff member asking "the customer says
-- they got nothing" had to open the chat and scroll, and nobody at
-- all could ask "what failed today". This adds the join and opens
-- the ledger to the staff who answer that question.
--
-- Two columns and one policy. No data is moved.
-- ============================================================

-- ------------------------------------------------------------
-- The join to delivery status.
--
-- Our own messages.id, not Meta's wamid: migration 009 records that
-- Meta's ids repeat across phone numbers, so message_id is not
-- unique and cannot be a key. ON DELETE SET NULL because a purged
-- conversation must not take the ledger row with it — WHY we sent
-- stays answerable after the message itself is gone.
-- ------------------------------------------------------------
ALTER TABLE erp_events
  ADD COLUMN IF NOT EXISTS message_id UUID REFERENCES messages(id) ON DELETE SET NULL;

-- ------------------------------------------------------------
-- The branch, as the ERP named it on the event.
--
-- A property of the ORDER, not of the customer: a contact can belong
-- to several stores (they bought at Shastri Nagar last year and
-- Bahadurgarh today), so `contact_stores` cannot answer "which shop
-- was THIS message about". Stored verbatim, like erp_review_queue
-- does, so the filter does not depend on parsing the detail text.
-- ------------------------------------------------------------
ALTER TABLE erp_events
  ADD COLUMN IF NOT EXISTS branch TEXT;

CREATE INDEX IF NOT EXISTS idx_erp_events_contact
  ON erp_events(account_id, contact_id)
  WHERE contact_id IS NOT NULL;

-- ------------------------------------------------------------
-- Who may read the ledger.
--
-- It was admin-only, because it was a support surface nobody else
-- had a screen for. Now branch staff have one, and the rule is the
-- same boundary the rest of the customer data uses: migration 043's
-- `can_access_contact`, so a Shastri Nagar agent sees Shastri Nagar's
-- rows and an owner sees all four shops.
--
-- Rows with NO contact stay admin-only. `ping`, an event whose
-- customer could not be resolved, and a branch that matched no store
-- are deployment diagnostics, not one shop's business, and
-- `can_access_contact(NULL)` is false — so this spells the admin
-- branch out rather than relying on that.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "Admins read erp events" ON erp_events;
DROP POLICY IF EXISTS erp_events_select ON erp_events;
CREATE POLICY erp_events_select ON erp_events
  FOR SELECT
  USING (
    is_account_member(account_id, 'admin')
    OR (contact_id IS NOT NULL AND can_access_contact(contact_id))
  );

-- Unchanged, and restated because migration 048's header warns that
-- a new grant is the half everyone forgets: the browser reads this
-- table, the ERP route writes it as service_role.
GRANT SELECT ON erp_events TO authenticated;
GRANT ALL ON erp_events TO service_role;
