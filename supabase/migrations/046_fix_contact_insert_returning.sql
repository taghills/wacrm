-- ============================================================
-- 046_fix_contact_insert_returning.sql
--
-- Migration 043 broke creating a contact from the UI, for every
-- role including the owner. Reported as "Failed to save contact".
--
-- What actually happens
--
--   The contact form does INSERT ... RETURNING id (it needs the id
--   to attach tags). Postgres applies a table's SELECT policy to the
--   rows an INSERT returns, as a WITH CHECK on the new row.
--
--   043's policy was `USING (can_access_contact(id))`, and that
--   helper re-queries `contacts` by id. The row being inserted is
--   not visible to a fresh query inside the same command, so the
--   helper returned false for everyone and the insert was rejected
--   with "new row violates row-level security policy".
--
--   Reproduced on a local Postgres 16 against the 043 shape: the
--   same INSERT succeeds without RETURNING and fails with it, as
--   agent, admin and owner alike.
--
-- Two things were wrong, and both need fixing
--
--   1. The policy re-queried its own table. It now reads the row's
--      own `id` and `account_id`, passed in as arguments, so there
--      is no self-query to miss. That alone fixes owner and admin.
--
--   2. For a store-bound agent the policy also needs the
--      contact_stores link, and 043 created that in an AFTER INSERT
--      trigger — after RETURNING is checked. The trigger moves to
--      BEFORE INSERT, which requires the FK to be deferrable since
--      the contacts row does not exist yet. The constraint is still
--      enforced, just at commit.
--
--      Column defaults are applied before BEFORE ROW triggers, so
--      NEW.id is populated.
--
--   The helper is VOLATILE, not STABLE. A STABLE function uses the
--   calling statement's snapshot, which predates the link the
--   BEFORE trigger just wrote — verified: with STABLE the agent
--   still failed while admin and owner passed. Measured both on a
--   20k-row table: a 500-row list read is ~1.4-1.9ms either way,
--   the difference lost in noise, so correctness wins.
--
-- can_access_contact(id) stays as-is and keeps its STABLE
-- definition. Every other policy that calls it (conversations,
-- messages, contact_notes, contact_tags, contact_custom_values)
-- queries `contacts` from a different table, where the row exists,
-- so none of them hit this.
--
-- Idempotent — safe to run more than once.
-- ============================================================

-- ============================================================
-- 1. A helper that reads the row instead of re-querying it
-- ============================================================
CREATE OR REPLACE FUNCTION can_access_contact_row(
  target_contact_id UUID,
  target_account_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM profiles p
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id
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
        p.account_role IN ('owner', 'admin')
        OR EXISTS (
          SELECT 1 FROM contact_stores cs
          WHERE cs.contact_id = target_contact_id
            AND cs.store_id = p.store_id
        )
      )
  );
$$;

ALTER FUNCTION can_access_contact_row(UUID, UUID, account_role_enum) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION can_access_contact_row(UUID, UUID, account_role_enum)
  TO authenticated, service_role;

-- ============================================================
-- 2. The link must exist before RETURNING is checked
--
-- ON DELETE CASCADE is preserved; only the timing of the check
-- changes. DEFERRABLE INITIALLY DEFERRED still rejects an orphan,
-- at commit rather than at statement end.
-- ============================================================
ALTER TABLE contact_stores
  DROP CONSTRAINT IF EXISTS contact_stores_contact_id_fkey;
ALTER TABLE contact_stores
  ADD CONSTRAINT contact_stores_contact_id_fkey
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
  DEFERRABLE INITIALLY DEFERRED;

DROP TRIGGER IF EXISTS link_new_contact_to_creator_store ON contacts;
CREATE TRIGGER link_new_contact_to_creator_store
  BEFORE INSERT ON contacts
  FOR EACH ROW EXECUTE FUNCTION link_new_contact_to_creator_store();

-- ============================================================
-- 3. Point the contacts policies at the row-based helper
--
-- SELECT is the one that was broken. UPDATE and DELETE move too:
-- they are the same rule, and leaving them on a helper that
-- re-queries the table would invite the same trap the first time
-- someone writes UPDATE ... RETURNING.
-- ============================================================
DROP POLICY IF EXISTS contacts_select ON contacts;
DROP POLICY IF EXISTS contacts_update ON contacts;
DROP POLICY IF EXISTS contacts_delete ON contacts;

CREATE POLICY contacts_select ON contacts FOR SELECT
  USING (can_access_contact_row(id, account_id));
CREATE POLICY contacts_update ON contacts FOR UPDATE
  USING (can_access_contact_row(id, account_id, 'agent'))
  WITH CHECK (can_access_contact_row(id, account_id, 'agent'));
CREATE POLICY contacts_delete ON contacts FOR DELETE
  USING (can_access_contact_row(id, account_id, 'agent'));
