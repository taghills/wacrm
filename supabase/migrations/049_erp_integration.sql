-- ============================================================
-- 049_erp_integration.sql — receive events from the TAGHills ERP
--
-- Context
--
--   The ERP (erp.taghills.com) is the system of record for
--   customers, orders and payments. It pushes events to
--   POST /api/erp/events, which turns them into CRM contacts and
--   outbound WhatsApp template messages.
--
--   Three things the application cannot do without schema support:
--
--     1. Match an ERP customer back to a CRM contact. The ERP's key
--        is `erpCustomerId` (a UUID of its own); phone is only a
--        secondary match, because a customer can change their number
--        and two ERP customers can share a household number.
--
--     2. Refuse to deliver a second message for an event the ERP
--        re-sends. The ERP retries a batch up to 8 times with
--        backoff, so "received this id before" has to be a durable
--        fact, not an in-memory set that a cold start forgets.
--
--     3. Honour a customer who has opted out. Birthday and recall
--        messages are marketing under WhatsApp policy; order and
--        payment messages are transactional. The opt-out flag is the
--        line between "skip" and "send".
--
-- Idempotent — safe to run more than once.
-- ============================================================

-- ============================================================
-- CONTACT -> ERP CUSTOMER
--
-- Nullable: contacts created by an inbound WhatsApp message have no
-- ERP counterpart until the customer places an order. The unique
-- index is partial so the NULLs do not collide.
-- ============================================================
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS erp_customer_id TEXT;

COMMENT ON COLUMN contacts.erp_customer_id IS
  'The TAGHills ERP customer id this contact mirrors. NULL for contacts that have never appeared in the ERP. Primary match key for erp customer.upsert events; phone is the fallback.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_erp_customer
  ON contacts(account_id, erp_customer_id)
  WHERE erp_customer_id IS NOT NULL;

-- ============================================================
-- MARKETING CONSENT
--
-- Default FALSE — an existing customer has not opted out. The flag
-- is set when a customer replies STOP (or an agent sets it by hand);
-- the ERP never writes it, because consent belongs to the channel
-- the customer spoke on, which is this one.
--
-- Transactional messages (order, payment) deliberately ignore it:
-- they are service messages about an order the customer placed, not
-- marketing, and suppressing them would be a worse customer
-- experience than the opt-out was asking for.
-- ============================================================
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS marketing_opt_out BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS marketing_opt_out_at TIMESTAMPTZ;

COMMENT ON COLUMN contacts.marketing_opt_out IS
  'TRUE when this customer has asked to stop receiving marketing (birthday wishes, eye-test recalls). Transactional order/payment messages are unaffected.';

-- ============================================================
-- EVENT LEDGER (idempotency)
--
-- One row per (account, ERP event id). The ERP may re-deliver the
-- same id after a timeout where our side actually succeeded; the
-- primary key is what stops a customer getting the same "your order
-- is ready" twice.
--
-- `status` records the outcome so a failed event can be retried by
-- the ERP without the ledger claiming it was already handled:
--   'done'    — processed; re-delivery is ignored.
--   'skipped' — deliberately not acted on (opted out, no phone,
--               unknown type). Also final; re-delivery is ignored.
--   'failed'  — our side errored. Reported back to the ERP in the
--               `failed` array so it retries, and the row is
--               overwritten on the retry.
--
-- Rows are small and bounded by the ERP's own event volume; no TTL
-- for now. If that ever changes, deleting rows older than the ERP's
-- retry window (8 attempts over ~4 hours) is safe.
-- ============================================================
CREATE TABLE IF NOT EXISTS erp_events (
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- The ERP's own event id, verbatim. TEXT because the ERP sends
  -- "1042" today and is free to switch to a UUID later.
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'done'
    CHECK (status IN ('done', 'skipped', 'failed')),
  -- Why a 'skipped' or 'failed' row ended up that way, for support.
  detail TEXT,
  -- The contact the event resolved to, when it resolved to one.
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_erp_events_received
  ON erp_events(account_id, received_at DESC);

ALTER TABLE erp_events ENABLE ROW LEVEL SECURITY;

-- Admin-and-above may read the ledger (it is a support/debug
-- surface, not day-to-day data). Nobody writes it from the browser —
-- the only writer is the ERP route, which runs as service_role.
DROP POLICY IF EXISTS "Admins read erp events" ON erp_events;
CREATE POLICY "Admins read erp events" ON erp_events
  FOR SELECT
  USING (is_account_member(account_id, 'admin'));

GRANT SELECT ON erp_events TO authenticated;
GRANT ALL ON erp_events TO service_role;
