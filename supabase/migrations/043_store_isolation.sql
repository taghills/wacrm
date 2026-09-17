-- ============================================================
-- 043_store_isolation.sql — store-wise staff isolation
--
-- Business requirement (TAGHills)
--
--   Staff belong to a physical store and must only see the
--   customers / chats of that store. Owner + admin see every
--   store in the account. A customer legitimately belongs to
--   MORE THAN ONE store (they order from Shashtri Nagar and
--   later from Bahadurgarh), and every store they belong to
--   sees the chat — there is only ever one WhatsApp thread per
--   customer, so it cannot be split.
--
-- The model
--
--   stores          one row per physical store, account-scoped.
--   profiles.store_id
--                   the staff member's store. NULL for owner /
--                   admin (they are not store-bound).
--   contact_stores  many-to-many: which stores a customer
--                   belongs to. THIS IS THE SECURITY BOUNDARY.
--                   Filled by the ERP (a sales order) or by the
--                   customer picking a branch in the bot menu.
--
--   A contact with NO rows in contact_stores is "unassigned" and
--   is visible to owner / admin only. That is the deliberate
--   fail-closed default: a brand-new inbound WhatsApp enquiry is
--   never auto-shown to a store that has no relationship yet.
--
-- Why the boundary is the CONTACT, not the conversation
--
--   One customer = one WhatsApp thread (enforced by migration
--   036's unique index on (account_id, contact_id)). Hanging
--   visibility off the contact means the chat, its messages, its
--   notes, tags and custom values all resolve through a single
--   rule, and a customer gaining a second store immediately gains
--   the second store's visibility with no row rewrites.
--
-- What inherits automatically
--
--   messages                -> via conversations -> contact
--   contact_tags            -> via contact
--   contact_custom_values   -> via contact
--   contact_notes           -> re-pointed at the contact here
--                              (it previously gated on its own
--                              account_id, so it did NOT inherit)
--
-- Fail-closed rules baked in
--
--   * An agent / viewer whose store_id is NULL sees NOTHING.
--     Store-bound roles must be assigned a store explicitly;
--     "unset" never means "all". Only owner / admin bypass.
--   * profiles.store_id is added to the 034 privilege-column
--     trigger, so a store agent cannot move themselves to
--     another store from the browser.
--
-- Idempotent — safe to run more than once.
--
-- NOTE: this migration does NOT create the stores themselves and
-- does NOT assign any staff. Seeding is a separate, reviewable
-- step so this file stays environment-independent.
-- ============================================================

-- ============================================================
-- STORES
-- ============================================================
CREATE TABLE IF NOT EXISTS stores (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- Short human code used in exports / the ERP handshake.
  code TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Codes are matched case-insensitively so the ERP can send 'shnr'
-- or 'SHNR' and still hit the same store.
CREATE UNIQUE INDEX IF NOT EXISTS idx_stores_account_code
  ON stores(account_id, lower(code));

CREATE INDEX IF NOT EXISTS idx_stores_account_active
  ON stores(account_id) WHERE active;

ALTER TABLE stores ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_updated_at ON stores;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON stores
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- PROFILE -> STORE
--
-- NULL means "not store-bound". For owner / admin that means
-- every store; for agent / viewer it means no store at all (see
-- can_access_contact below). The asymmetry is intentional.
-- ============================================================
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES stores(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_profiles_store ON profiles(store_id)
  WHERE store_id IS NOT NULL;

-- ============================================================
-- CONTACT <-> STORE  (the security boundary)
-- ============================================================
CREATE TABLE IF NOT EXISTS contact_stores (
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  -- Denormalised for cheap account-scoped admin queries; the
  -- authorization path reads contacts.account_id, not this.
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Where the link came from. 'erp' is the trusted one (a real
  -- sales order); 'bot' is the customer's own branch pick;
  -- 'manual' is an admin assigning by hand.
  source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('erp', 'bot', 'manual')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (contact_id, store_id)
);

CREATE INDEX IF NOT EXISTS idx_contact_stores_store
  ON contact_stores(store_id);

ALTER TABLE contact_stores ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- AUTHORIZATION HELPER
--
-- Owned by postgres and SECURITY DEFINER for the same reason
-- is_account_member() is (migration 017): the table owner
-- bypasses RLS, so reading contacts / profiles / contact_stores
-- inside a policy cannot recurse back into those tables' own
-- policies.
--
-- Returns TRUE when the caller may act on `target_contact_id`
-- at `min_role` or above:
--   owner / admin  -> any contact in their account
--   agent / viewer -> only if their store is one of the
--                     contact's stores
-- ============================================================
CREATE OR REPLACE FUNCTION can_access_contact(
  target_contact_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM contacts ct
    JOIN profiles p ON p.account_id = ct.account_id
    WHERE ct.id = target_contact_id
      AND p.user_id = auth.uid()
      AND CASE p.account_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
        >=
          CASE min_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
      AND (
        -- Not store-bound: sees the whole account.
        p.account_role IN ('owner', 'admin')
        -- Store-bound: needs an explicit store AND a link to it.
        -- p.store_id IS NULL therefore matches nothing.
        OR EXISTS (
          SELECT 1 FROM contact_stores cs
          WHERE cs.contact_id = ct.id
            AND cs.store_id = p.store_id
        )
      )
  );
$$;

ALTER FUNCTION can_access_contact(UUID, account_role_enum) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION can_access_contact(UUID, account_role_enum)
  TO authenticated, service_role;

-- ============================================================
-- AUTO-LINK A MANUALLY CREATED CONTACT
--
-- A store agent adding a walk-in by hand would otherwise create a
-- contact they immediately cannot see. Link it to their own store
-- on insert. Owner / admin inserts (store_id NULL) create an
-- unassigned contact, which is the correct outcome for them.
--
-- The webhook inserts as service_role, where auth.uid() is NULL,
-- so inbound WhatsApp contacts are untouched here and stay
-- unassigned until the bot or the ERP links them.
-- ============================================================
CREATE OR REPLACE FUNCTION link_new_contact_to_creator_store()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  creator_store UUID;
BEGIN
  SELECT p.store_id INTO creator_store
  FROM profiles p
  WHERE p.user_id = auth.uid()
    AND p.account_id = NEW.account_id;

  IF creator_store IS NOT NULL THEN
    INSERT INTO contact_stores (contact_id, store_id, account_id, source)
    VALUES (NEW.id, creator_store, NEW.account_id, 'manual')
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION link_new_contact_to_creator_store() OWNER TO postgres;

DROP TRIGGER IF EXISTS link_new_contact_to_creator_store ON contacts;
CREATE TRIGGER link_new_contact_to_creator_store
  AFTER INSERT ON contacts
  FOR EACH ROW EXECUTE FUNCTION link_new_contact_to_creator_store();

-- ============================================================
-- PRIVILEGE-COLUMN GUARD (extends migration 034)
--
-- store_id now decides what a staff member can see, so it is a
-- privilege column: the browser (`authenticated`) must not be
-- able to change it. The sanctioned writers are the SECURITY
-- DEFINER RPCs (current_user = postgres) and the server backend
-- (service_role), exactly as for account_role / account_id.
-- ============================================================
CREATE OR REPLACE FUNCTION public.enforce_profile_privilege_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.account_role IS DISTINCT FROM OLD.account_role
      OR NEW.account_id IS DISTINCT FROM OLD.account_id
      OR NEW.store_id IS DISTINCT FROM OLD.store_id)
     AND current_user = 'authenticated'
  THEN
    RAISE EXCEPTION
      'account_role, account_id and store_id cannot be changed directly; use the account member RPCs'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_profile_privilege_columns() OWNER TO postgres;

-- ============================================================
-- POLICIES — stores
--
-- Every member may read the store list (the inbox filter and the
-- bot menu need it). Only admin+ may change it.
-- ============================================================
DROP POLICY IF EXISTS stores_select ON stores;
DROP POLICY IF EXISTS stores_insert ON stores;
DROP POLICY IF EXISTS stores_update ON stores;
DROP POLICY IF EXISTS stores_delete ON stores;

CREATE POLICY stores_select ON stores FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY stores_insert ON stores FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY stores_update ON stores FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY stores_delete ON stores FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- POLICIES — contact_stores
--
-- Readable for any contact you can already see. Only admin+ may
-- edit links from the browser: a store agent must not be able to
-- attach someone else's customer to their own store, which would
-- be a self-service grant of access. The ERP sync and the bot run
-- as service_role and are unaffected.
-- ============================================================
DROP POLICY IF EXISTS contact_stores_select ON contact_stores;
DROP POLICY IF EXISTS contact_stores_modify ON contact_stores;

CREATE POLICY contact_stores_select ON contact_stores FOR SELECT
  USING (can_access_contact(contact_id));
CREATE POLICY contact_stores_modify ON contact_stores FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

-- ============================================================
-- POLICIES — contacts  (replaces migration 017's account-only)
--
-- INSERT still gates on account membership only: a brand-new row
-- has no id to check links against, and the AFTER INSERT trigger
-- above attaches the creator's store.
-- ============================================================
DROP POLICY IF EXISTS contacts_select ON contacts;
DROP POLICY IF EXISTS contacts_update ON contacts;
DROP POLICY IF EXISTS contacts_delete ON contacts;

CREATE POLICY contacts_select ON contacts FOR SELECT
  USING (can_access_contact(id));
CREATE POLICY contacts_update ON contacts FOR UPDATE
  USING (can_access_contact(id, 'agent'))
  WITH CHECK (can_access_contact(id, 'agent'));
CREATE POLICY contacts_delete ON contacts FOR DELETE
  USING (can_access_contact(id, 'agent'));

-- ============================================================
-- POLICIES — conversations
-- ============================================================
DROP POLICY IF EXISTS conversations_select ON conversations;
DROP POLICY IF EXISTS conversations_insert ON conversations;
DROP POLICY IF EXISTS conversations_update ON conversations;
DROP POLICY IF EXISTS conversations_delete ON conversations;

CREATE POLICY conversations_select ON conversations FOR SELECT
  USING (can_access_contact(contact_id));
CREATE POLICY conversations_insert ON conversations FOR INSERT
  WITH CHECK (can_access_contact(contact_id, 'agent'));
CREATE POLICY conversations_update ON conversations FOR UPDATE
  USING (can_access_contact(contact_id, 'agent'))
  WITH CHECK (can_access_contact(contact_id, 'agent'));
CREATE POLICY conversations_delete ON conversations FOR DELETE
  USING (can_access_contact(contact_id, 'agent'));

-- ============================================================
-- POLICIES — messages (inherit through the conversation)
-- ============================================================
DROP POLICY IF EXISTS messages_select ON messages;
DROP POLICY IF EXISTS messages_modify ON messages;

CREATE POLICY messages_select ON messages FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND can_access_contact(c.contact_id)
  )
);
CREATE POLICY messages_modify ON messages FOR ALL USING (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND can_access_contact(c.contact_id, 'agent')
  )
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND can_access_contact(c.contact_id, 'agent')
  )
);

-- ============================================================
-- POLICIES — contact_notes
--
-- Previously gated on contact_notes.account_id, so it did NOT
-- inherit from the contact. Re-pointed so notes follow the same
-- store rule as everything else on the customer file.
-- ============================================================
DROP POLICY IF EXISTS contact_notes_select ON contact_notes;
DROP POLICY IF EXISTS contact_notes_insert ON contact_notes;
DROP POLICY IF EXISTS contact_notes_update ON contact_notes;
DROP POLICY IF EXISTS contact_notes_delete ON contact_notes;

CREATE POLICY contact_notes_select ON contact_notes FOR SELECT
  USING (can_access_contact(contact_id));
CREATE POLICY contact_notes_insert ON contact_notes FOR INSERT
  WITH CHECK (can_access_contact(contact_id, 'agent'));
CREATE POLICY contact_notes_update ON contact_notes FOR UPDATE
  USING (can_access_contact(contact_id, 'agent'))
  WITH CHECK (can_access_contact(contact_id, 'agent'));
CREATE POLICY contact_notes_delete ON contact_notes FOR DELETE
  USING (can_access_contact(contact_id, 'agent'));

-- ============================================================
-- POLICIES — contact_tags / contact_custom_values
--
-- These already inherited from the contact, but via
-- is_account_member(c.account_id). Re-point at can_access_contact
-- so they carry the store rule too.
-- ============================================================
DROP POLICY IF EXISTS contact_tags_select ON contact_tags;
DROP POLICY IF EXISTS contact_tags_modify ON contact_tags;

CREATE POLICY contact_tags_select ON contact_tags FOR SELECT
  USING (can_access_contact(contact_id));
CREATE POLICY contact_tags_modify ON contact_tags FOR ALL
  USING (can_access_contact(contact_id, 'agent'))
  WITH CHECK (can_access_contact(contact_id, 'agent'));

DROP POLICY IF EXISTS contact_custom_values_select ON contact_custom_values;
DROP POLICY IF EXISTS contact_custom_values_modify ON contact_custom_values;

CREATE POLICY contact_custom_values_select ON contact_custom_values FOR SELECT
  USING (can_access_contact(contact_id));
CREATE POLICY contact_custom_values_modify ON contact_custom_values FOR ALL
  USING (can_access_contact(contact_id, 'agent'))
  WITH CHECK (can_access_contact(contact_id, 'agent'));

-- ============================================================
-- TABLE PRIVILEGES
--
-- RLS decides which rows; these GRANTs decide whether the role
-- may touch the table at all. Mirrors the privileges the rest of
-- the schema carries. anon gets nothing.
-- ============================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON stores TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON contact_stores TO authenticated;
GRANT ALL ON stores TO service_role;
GRANT ALL ON contact_stores TO service_role;
