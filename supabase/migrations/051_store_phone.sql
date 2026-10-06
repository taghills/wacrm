-- ============================================================
-- 051_store_phone.sql — a contact number per store
--
-- Customer-facing messages name the branch ("ready for collection at
-- our Shastri Nagar store") but gave the customer no way to ring it.
-- A `stores` row carried only a name, a code and an active flag, so
-- there was nothing for the message to fill in.
--
-- The number lives here rather than arriving on each ERP event: it is
-- shop information the CRM owner should be able to correct in one
-- place, without a change to the ERP and without waiting for the next
-- order to carry the new value.
--
-- Free-form TEXT, not a validated phone type. It is printed in a
-- message for a human to read and dial, never dialled by this system
-- and never matched against anything, so "+91 76786 88524" and
-- "011-4567 8900" are equally valid and a format check would only
-- reject real numbers. The API caps its length; that is the only
-- constraint worth having.
--
-- NULL means "no number set". The send path falls back rather than
-- putting an empty value in a message — WhatsApp rejects a template
-- parameter that is blank, so an unset number must never reach it.
--
-- No numbers are seeded here. This repository is public; real phone
-- numbers belong in the operator's database, entered through
-- Settings -> Stores, not in version control.
--
-- Idempotent — safe to run more than once.
-- ============================================================

ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS phone TEXT;

COMMENT ON COLUMN stores.phone IS
  'Public contact number for this branch, shown to customers in WhatsApp messages. Free-form, as a human would dial it. NULL = not set; the send path falls back rather than sending an empty template parameter.';
