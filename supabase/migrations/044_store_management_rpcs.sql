-- ============================================================
-- 044_store_management_rpcs.sql — assigning a member to a store
--
-- Migration 043 made `profiles.store_id` a privilege column: it
-- decides which customers a staff member can see, so 034's
-- BEFORE UPDATE trigger refuses any change to it coming from the
-- `authenticated` role. That is deliberate — a store agent must
-- not be able to PATCH themselves into another branch — but it
-- also means the Settings UI cannot write the column directly.
--
-- Same shape as migration 018's member RPCs: a SECURITY DEFINER
-- function owned by `postgres`, so `current_user` inside it is
-- `postgres` and the 034 guard lets the write through, while the
-- function itself does the real authorization.
--
-- Rules enforced here:
--   - caller must be authenticated and admin+
--   - caller cannot change their own store (mirrors
--     set_member_role; owner/admin ignore store_id anyway, so
--     there is nothing to gain and one less self-service path)
--   - target must be a member of the caller's account
--   - the store, when not NULL, must belong to that same account
--   - NULL is allowed and means "not store-bound"
--
-- Idempotent — CREATE OR REPLACE.
-- ============================================================

CREATE OR REPLACE FUNCTION public.set_member_store(
  p_user_id UUID,
  p_store_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_account_id UUID;
  v_store_account_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role
  INTO v_caller_account_id, v_caller_role
  FROM profiles
  WHERE user_id = auth.uid();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot change your own store'
      USING ERRCODE = '22023';
  END IF;

  SELECT account_id INTO v_target_account_id
  FROM profiles
  WHERE user_id = p_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  -- A store from another account would silently grant nothing (no
  -- contact_stores row could ever match), but reject it loudly
  -- rather than leave an agent staring at an empty inbox.
  IF p_store_id IS NOT NULL THEN
    SELECT account_id INTO v_store_account_id
    FROM stores
    WHERE id = p_store_id;

    IF v_store_account_id IS NULL THEN
      RAISE EXCEPTION 'Store not found' USING ERRCODE = '22023';
    END IF;

    IF v_store_account_id <> v_caller_account_id THEN
      RAISE EXCEPTION 'Store is not in your account' USING ERRCODE = '42501';
    END IF;
  END IF;

  UPDATE profiles
  SET store_id = p_store_id
  WHERE user_id = p_user_id;
END;
$$;

ALTER FUNCTION public.set_member_store(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_member_store(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_member_store(UUID, UUID) TO authenticated;
