-- ============================================================
-- 048_table_privileges.sql — put table privileges in version control
--
-- The problem
--
--   RLS decides WHICH ROWS a role may touch. It does not grant the
--   right to touch the table at all — that is a separate GRANT, and
--   this repo never had one for the application tables. A database
--   built from these migrations alone comes up with RLS enabled,
--   policies in place, and `authenticated` unable to read anything:
--
--     permission denied for table profiles
--
--   The production database works only because those GRANTs were
--   issued by hand in the Supabase SQL editor during setup. That is
--   not reproducible. Restoring from a migration-built database, or
--   standing up a staging copy, yields an app that cannot start —
--   and the failure looks like a bug in the app rather than a
--   missing one-off command nobody recorded.
--
--   Measured before this migration: 38 tables in `public`, 3 of them
--   grantable by `authenticated` (stores, contact_stores,
--   access_roles — the only ones whose own migrations happened to
--   include a GRANT).
--
-- The model
--
--   Derive each table's privileges from its own policies rather than
--   listing them by hand. A policy exists precisely to describe what
--   a role may do with a table, so the policy set IS the intended
--   privilege set; writing the list separately would only create a
--   second source of truth to drift from the first.
--
--     FOR SELECT policy -> GRANT SELECT
--     FOR INSERT        -> GRANT INSERT
--     FOR UPDATE        -> GRANT UPDATE
--     FOR DELETE        -> GRANT DELETE
--     FOR ALL           -> all four
--
--   Deriving also covers tables this could not be verified against
--   locally — ai_knowledge_documents and ai_knowledge_chunks need
--   pgvector, which is unavailable outside Supabase — because the
--   loop reads whatever policies exist at apply time.
--
--   Checked against the two documented cases from the original
--   hand-run repair, and the derivation reproduces both exactly:
--   contacts gets SELECT/INSERT/UPDATE/DELETE, notifications gets
--   SELECT/UPDATE, profiles gets INSERT/SELECT/UPDATE.
--
-- Deliberate omissions
--
--   anon gets nothing. It is the role an unauthenticated visitor
--   uses, and no screen reads application data before sign-in.
--
--   automation_pending_executions gets nothing for `authenticated`.
--   RLS is on with no policy at all, because the cron route and the
--   automation engine drive it through the service role; granting
--   it would hand out a table the policies deliberately close.
--
--   member_presence gets SELECT only. Writes go through the
--   touch_presence RPC (SECURITY DEFINER), not a direct upsert.
--
-- This migration only ADDS privileges. It issues no REVOKE, so
-- applying it to the live database cannot take away anything that
-- is working there today; it brings a *fresh* database up to the
-- same state. Tightening anything the hand-run repair over-granted
-- is a separate decision, made against a real audit of production
-- rather than blind.
--
-- New tables must still carry their own GRANT in their own
-- migration, as 043 and 045 do. This is a repair, not a mechanism.
--
-- Idempotent — GRANT is additive and re-running changes nothing.
-- ============================================================

-- Supabase grants these by default on a new project; included so a
-- database built from this repo alone does not depend on that.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT tbl, string_agg(DISTINCT priv, ', ' ORDER BY priv) AS privs
    FROM (
      SELECT
        c.relname AS tbl,
        unnest(
          CASE pol.polcmd
            WHEN 'r' THEN ARRAY['SELECT']
            WHEN 'a' THEN ARRAY['INSERT']
            WHEN 'w' THEN ARRAY['UPDATE']
            WHEN 'd' THEN ARRAY['DELETE']
            WHEN '*' THEN ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']
          END
        ) AS priv
      FROM pg_policy pol
      JOIN pg_class c ON c.oid = pol.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      WHERE c.relkind = 'r'
    ) policy_privs
    GROUP BY tbl
  LOOP
    EXECUTE format(
      'GRANT %s ON public.%I TO authenticated', r.privs, r.tbl
    );
  END LOOP;
END
$$;

-- The server-side role. It bypasses RLS, but bypassing row security
-- is not the same as being allowed to open the table, so it needs
-- the grant too — including on the tables `authenticated` is
-- deliberately kept out of.
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;

-- No sequences exist today (every table keys on a uuid default), but
-- a future serial column would otherwise fail at insert time with a
-- permission error on the sequence rather than the table, which is a
-- confusing place to land.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public
  TO authenticated, service_role;
