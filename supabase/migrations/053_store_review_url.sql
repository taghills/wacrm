-- ============================================================
-- 053: a Google review link per store
--
-- Migration 052 gave the account ONE review link. That is wrong for
-- a business with more than one shop: Google attaches reviews to a
-- LOCATION, so each branch has its own listing, its own star rating
-- and its own review link. One link for all of them sends a
-- Bahadurgarh customer to review Shastri Nagar — the review lands on
-- the wrong branch's listing, and a customer who sees the wrong shop
-- name usually just closes the page.
--
-- The account-wide link in message_settings stays, as the fallback
-- for a store that has none yet. That matters during rollout: the
-- links can be collected one branch at a time without the review
-- message breaking for the others.
-- ============================================================

ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS review_url TEXT;

COMMENT ON COLUMN stores.review_url IS
  'This branch''s own Google review link, for review_request''s button. NULL falls back to message_settings.review_url.';
