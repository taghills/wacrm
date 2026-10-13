-- ============================================================
-- 056_erp_event_order_ref.sql — the bill number on the ledger row.
--
-- Message activity could name the customer and the branch but not
-- the ORDER, which is the one thing both halves of a conversation
-- already have in front of them: the customer is holding the bill
-- and the staff member is looking it up. "Asha Verma, Bahadurgarh,
-- not sent" is a worse answer than "BDGR-2627-SO-0014, not sent"
-- when four people called Asha bought glasses this month.
--
-- It also makes the search box worth having: a bill number is what
-- someone types.
--
-- Same key the review queue uses (`reviewOrderKey`): the bill number
-- when the event carries one, else the ERP's order id. An order can
-- reach delivery before it is billed, and an empty string would make
-- every such order look like the same one.
-- ============================================================

ALTER TABLE erp_events
  ADD COLUMN IF NOT EXISTS order_ref TEXT;

-- For "show me everything about this bill". Partial, because most
-- rows that carry no order (a contact sync) would otherwise sit in
-- the index for nothing.
CREATE INDEX IF NOT EXISTS idx_erp_events_order_ref
  ON erp_events(account_id, order_ref)
  WHERE order_ref IS NOT NULL;
