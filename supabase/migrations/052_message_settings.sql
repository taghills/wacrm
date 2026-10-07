-- ============================================================
-- 052: message settings, and the review request queue
--
-- Two things an operator needs to control without a developer:
-- where the review request sends people, and how long after
-- delivery it goes out.
--
-- Until now the review link lived in REVIEW_LINK_URL, a hosting
-- environment variable. That made it invisible in the app (the
-- status page could only say "set" or "not set"), editable by one
-- person, and changeable only with a redeploy. The delay did not
-- exist at all: the CRM waited for the ERP to decide when enough
-- days had passed, and the ERP never built that.
--
-- So the delay moves here, which needs a record of what is owed:
-- `erp_review_queue` is one row per delivered order, due on a
-- date, drained by the review cron.
-- ============================================================

-- ------------------------------------------------------------
-- message_settings — one row per account
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS message_settings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,

  -- Where `review_request`'s button sends the customer. NULL means
  -- unset, and the review request is held back rather than sent
  -- with an empty button — Meta rejects an empty parameter.
  review_url          text,

  -- Days after delivery before the review request goes out. 0 means
  -- "with the delivery message", which is allowed but discouraged:
  -- nobody has an opinion about eyewear they collected an hour ago.
  -- The ceiling is a guard against a typo (300 instead of 3)
  -- silently parking a message for most of a year.
  review_delay_days   integer NOT NULL DEFAULT 3
                        CHECK (review_delay_days BETWEEN 0 AND 90),

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE message_settings ENABLE ROW LEVEL SECURITY;

-- SELECT: any member. The send path reads these, and a staff member
-- seeing the review link is not a disclosure — it is a public
-- Google page.
DROP POLICY IF EXISTS message_settings_select ON message_settings;
CREATE POLICY message_settings_select ON message_settings FOR SELECT
  USING (is_account_member(account_id));

-- Writes: admin+, as with every other settings-class table.
DROP POLICY IF EXISTS message_settings_insert ON message_settings;
CREATE POLICY message_settings_insert ON message_settings FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS message_settings_update ON message_settings;
CREATE POLICY message_settings_update ON message_settings FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS message_settings_delete ON message_settings;
CREATE POLICY message_settings_delete ON message_settings FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON message_settings;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON message_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE message_settings IS
  'Per-account controls for the automatic WhatsApp messages: the review link and how long after delivery to ask.';
COMMENT ON COLUMN message_settings.review_url IS
  'Google review link for review_request''s URL button. NULL holds the message back rather than sending an empty button.';
COMMENT ON COLUMN message_settings.review_delay_days IS
  'Days after order.delivered before the review request is due. Capped at 90 to catch a typo.';

-- ------------------------------------------------------------
-- erp_review_queue — what is owed, and when
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS erp_review_queue (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,

  -- The ERP's own identifier for the order, so a redelivered or
  -- re-sent event cannot queue a second ask for the same pair of
  -- glasses. Bill no when the event has one, else the order id.
  erp_order_key   text NOT NULL,

  -- Captured at delivery rather than read back at send time: the
  -- branch that served the order is the branch whose name and phone
  -- number the message should carry, even if the customer is later
  -- re-filed somewhere else.
  branch          text,

  due_at          timestamptz NOT NULL,

  -- 'sending' is the claim: the drain moves a row into it before
  -- calling Meta, so two overlapping runs cannot both send the same
  -- request. A row stuck in 'sending' means the process died
  -- mid-send — visible on the status page, and deliberately NOT
  -- retried automatically, because the ask may already have gone.
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sending', 'sent', 'skipped', 'failed')),
  -- Why it ended that way, in the same words the event ledger uses.
  detail          text,
  sent_at         timestamptz,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- One ask per order, ever. This is the idempotency guarantee: the
-- ERP re-sending order.delivered, or a replayed batch, updates the
-- existing row instead of queueing a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_erp_review_queue_order
  ON erp_review_queue(account_id, erp_order_key);

-- The drain's only query: pending rows that are due.
CREATE INDEX IF NOT EXISTS idx_erp_review_queue_due
  ON erp_review_queue(status, due_at)
  WHERE status = 'pending';

ALTER TABLE erp_review_queue ENABLE ROW LEVEL SECURITY;

-- Admin-only, and read-only: this is a diagnostic surface, like
-- erp_events. Every write comes from the service role (the events
-- endpoint queues, the cron drains), which bypasses RLS.
DROP POLICY IF EXISTS erp_review_queue_select ON erp_review_queue;
CREATE POLICY erp_review_queue_select ON erp_review_queue FOR SELECT
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON erp_review_queue;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON erp_review_queue
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE erp_review_queue IS
  'One row per delivered order: the review request owed for it, and when it falls due. Drained by GET /api/erp/review/cron.';

-- Migration 048 revoked the blanket PUBLIC grants, so a new table
-- needs its service-role access stated. Both endpoints run as the
-- service role.
GRANT ALL ON TABLE message_settings TO service_role;
GRANT ALL ON TABLE erp_review_queue TO service_role;
