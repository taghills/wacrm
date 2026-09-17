-- ============================================================
-- 045_access_roles.sql — per-account UI access roles
--
-- The problem this solves
--
--   The settings rail shows every section to every member. The
--   upstream code even documents an `adminOnly` flag ("adminOnly
--   items are hidden for non-admins") that was never implemented:
--   there is no such field and no filtering. So an agent sees the
--   WhatsApp connection, the API-keys screen and the member roster
--   alongside their own profile settings.
--
-- What this is, and what it is NOT
--
--   These roles control VISIBILITY IN THE UI ONLY — which nav items
--   and which settings sections a member is shown. They are NOT an
--   authorization boundary and must never be treated as one.
--
--   The real boundary stays where it already is:
--     - account_role + is_account_member() for settings-class tables
--       (whatsapp_config, api_keys, message_templates, members) —
--       an agent's write is refused by RLS whatever the UI shows.
--     - can_access_contact() (043) for customer data.
--
--   An access role can therefore only ever HIDE something a member
--   could otherwise reach. Granting a section to someone whose
--   account_role cannot write it does not grant the write; the
--   database still refuses it. The resolver in
--   src/lib/access/modules.ts encodes that one-way rule.
--
-- Shape
--
--   permissions is a JSON object keyed by module id, each value one
--   of 'hidden' | 'view' | 'edit':
--
--     { "inbox": "edit", "broadcasts": "view",
--       "settings.whatsapp": "hidden", ... }
--
--   A module missing from the object falls back to the default for
--   the member's account_role (see modules.ts). That keeps a role
--   working when a later release adds a module, instead of hiding
--   the new screen from everyone who has a saved role.
--
-- Idempotent — safe to run more than once.
-- ============================================================

CREATE TABLE IF NOT EXISTS access_roles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- Module id -> 'hidden' | 'view' | 'edit'. Validated in the API
  -- layer; stored as jsonb so adding a module needs no migration.
  permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_access_roles_account_name
  ON access_roles(account_id, lower(name));

ALTER TABLE access_roles ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_updated_at ON access_roles;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON access_roles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- PROFILE -> ACCESS ROLE
--
-- NULL means "no custom role": the member sees whatever their
-- account_role defaults to. ON DELETE SET NULL so deleting a role
-- returns its holders to those defaults rather than orphaning them.
-- ============================================================
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS access_role_id UUID
    REFERENCES access_roles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_profiles_access_role
  ON profiles(access_role_id) WHERE access_role_id IS NOT NULL;

-- ============================================================
-- POLICIES
--
-- Every member may read the roles: the client resolver needs its
-- own row to decide what to render, and the Team members screen
-- shows each teammate's role name. Only admin+ may write.
-- ============================================================
DROP POLICY IF EXISTS access_roles_select ON access_roles;
DROP POLICY IF EXISTS access_roles_insert ON access_roles;
DROP POLICY IF EXISTS access_roles_update ON access_roles;
DROP POLICY IF EXISTS access_roles_delete ON access_roles;

CREATE POLICY access_roles_select ON access_roles FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY access_roles_insert ON access_roles FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY access_roles_update ON access_roles FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY access_roles_delete ON access_roles FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- PRIVILEGE-COLUMN GUARD (extends 034, and 043's store_id)
--
-- access_role_id decides what a member is shown, so self-service
-- edits from the browser are out — otherwise anyone could clear
-- their own role and fall back to the account_role defaults.
-- Not a security hole (the UI is not the boundary), but a
-- restriction the admin set and the member should not undo.
-- ============================================================
CREATE OR REPLACE FUNCTION public.enforce_profile_privilege_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.account_role IS DISTINCT FROM OLD.account_role
      OR NEW.account_id IS DISTINCT FROM OLD.account_id
      OR NEW.store_id IS DISTINCT FROM OLD.store_id
      OR NEW.access_role_id IS DISTINCT FROM OLD.access_role_id)
     AND current_user = 'authenticated'
  THEN
    RAISE EXCEPTION
      'account_role, account_id, store_id and access_role_id cannot be changed directly; use the account member RPCs'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_profile_privilege_columns() OWNER TO postgres;

-- ============================================================
-- ASSIGNMENT RPC
--
-- Same shape as 044's set_member_store, for the same reason: the
-- guard above refuses a direct write from `authenticated`.
--
-- Self-assignment is allowed here, unlike store and role, and the
-- asymmetry is deliberate: an admin restricting their own UI is
-- harmless (the account_role still decides what they can DO), and
-- an owner setting up roles will want to preview one.
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_member_access_role(
  p_user_id UUID,
  p_access_role_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_account_id UUID;
  v_role_account_id UUID;
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

  IF p_access_role_id IS NOT NULL THEN
    SELECT account_id INTO v_role_account_id
    FROM access_roles
    WHERE id = p_access_role_id;

    IF v_role_account_id IS NULL THEN
      RAISE EXCEPTION 'Access role not found' USING ERRCODE = '22023';
    END IF;

    IF v_role_account_id <> v_caller_account_id THEN
      RAISE EXCEPTION 'Access role is not in your account'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  UPDATE profiles
  SET access_role_id = p_access_role_id
  WHERE user_id = p_user_id;
END;
$$;

ALTER FUNCTION public.set_member_access_role(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_member_access_role(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_member_access_role(UUID, UUID) TO authenticated;

-- ============================================================
-- TABLE PRIVILEGES
-- ============================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON access_roles TO authenticated;
GRANT ALL ON access_roles TO service_role;
