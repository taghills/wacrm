-- Post-migration assertions for the CI job in
-- `.github/workflows/migrations.yml`.
--
-- `supabase db reset` already fails on any statement Postgres rejects,
-- so this is not about syntax. It's about the quieter failure: a
-- migration that applies cleanly and does nothing. Every DDL statement
-- in this repo is guarded with IF NOT EXISTS / ON CONFLICT so the files
-- can be re-run safely, and that same guard turns a typo'd object name
-- into a silent no-op with a green checkmark.
--
-- Keep this thin. It is a smoke test for "did the migrations actually
-- build the schema", not a spec of it — asserting every column here
-- would just be the migrations restated in a second place, drifting.
DO $$
BEGIN
  -- The core tables, from 001.
  IF to_regclass('public.messages') IS NULL THEN
    RAISE EXCEPTION 'public.messages is missing — migrations did not apply';
  END IF;
  IF to_regclass('public.whatsapp_config') IS NULL THEN
    RAISE EXCEPTION 'public.whatsapp_config is missing — migrations did not apply';
  END IF;

  -- Supabase provides the storage schema; migrations 016/020/023 write
  -- to it. If it is absent the bucket migrations silently accomplish
  -- nothing, which is precisely the case a plain "no errors" run hides.
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE EXCEPTION
      'storage.buckets is missing — the storage schema was not available when the bucket migrations ran';
  END IF;

  -- Buckets are UPSERTed, so their absence means the INSERT never ran.
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'chat-media') THEN
    RAISE EXCEPTION 'the chat-media bucket row was not created (migration 023)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'flow-media') THEN
    RAISE EXCEPTION 'the flow-media bucket row was not created (migration 016)';
  END IF;

  -- Account scoping (017) is load-bearing for every RLS policy.
  IF to_regclass('public.accounts') IS NULL THEN
    RAISE EXCEPTION 'public.accounts is missing — migration 017 did not apply';
  END IF;

  -- The BSUID index (040) is the only thing stopping a username-only
  -- WhatsApp sender from forking a new contact per inbound message. A
  -- typo in its name would apply cleanly and guarantee nothing.
  IF to_regclass('public.idx_contacts_account_wa_user_id') IS NULL THEN
    RAISE EXCEPTION
      'idx_contacts_account_wa_user_id is missing — migration 040 did not apply';
  END IF;

  -- 041 repairs create_broadcast_with_recipients, which 037/038 shipped
  -- with an ambiguous bare `RETURNING id, contact_id` (SQLSTATE 42702 on
  -- first call — plpgsql resolves names at execution, not CREATE, so a
  -- plain replay can't catch it). Assert the qualified form is what's
  -- actually installed.
  IF pg_get_functiondef(
       'public.create_broadcast_with_recipients(uuid,uuid,text,text,text,integer,uuid[],jsonb[])'::regprocedure
     ) NOT LIKE '%RETURNING id, broadcast_recipients.contact_id%' THEN
    RAISE EXCEPTION
      'create_broadcast_with_recipients still has the ambiguous RETURNING — migration 041 did not apply';
  END IF;

  -- The failure-reason columns (042) are only ever written by the
  -- status webhook, which uses an untyped update — a missing column
  -- there is a runtime PostgREST error on every failed send, not a
  -- compile error.
  IF (
    SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages'
      AND column_name IN ('error_code', 'error_title', 'error_details')
  ) <> 3 THEN
    RAISE EXCEPTION
      'messages.error_code/error_title/error_details are missing — migration 042 did not apply';
  END IF;

  -- Store isolation, from 043. The stores tables plus the helper
  -- every store-scoped policy calls — a missing helper would make
  -- the policies fail open at query time, not at apply time.
  IF to_regclass('public.stores') IS NULL THEN
    RAISE EXCEPTION 'public.stores is missing — migration 043 did not apply';
  END IF;
  IF to_regclass('public.contact_stores') IS NULL THEN
    RAISE EXCEPTION 'public.contact_stores is missing — migration 043 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles'
      AND column_name = 'store_id'
  ) THEN
    RAISE EXCEPTION 'profiles.store_id is missing — migration 043 did not apply';
  END IF;
  IF to_regprocedure('public.can_access_contact(uuid, account_role_enum)') IS NULL THEN
    RAISE EXCEPTION
      'can_access_contact() is missing — migration 043 did not apply';
  END IF;

  -- 046's row-based helper and the deferrable FK it depends on.
  -- Without both, INSERT ... RETURNING on contacts is rejected for
  -- every role — the whole point of that migration.
  IF to_regprocedure('public.can_access_contact_row(uuid, uuid, account_role_enum)') IS NULL THEN
    RAISE EXCEPTION
      'can_access_contact_row() is missing — migration 046 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'contact_stores_contact_id_fkey'
      AND condeferrable AND condeferred
  ) THEN
    RAISE EXCEPTION
      'contact_stores_contact_id_fkey is not DEFERRABLE INITIALLY DEFERRED — migration 046 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'link_new_contact_to_creator_store'
      AND tgrelid = 'public.contacts'::regclass
      -- tgtype bit 1 set = BEFORE. 046 moved this from AFTER.
      AND (tgtype & 2) = 2
  ) THEN
    RAISE EXCEPTION
      'link_new_contact_to_creator_store is not a BEFORE trigger — migration 046 did not apply';
  END IF;

  RAISE NOTICE 'schema verification passed';
END
$$;

-- Two things this file has already been burned by, both verified in CI
-- rather than assumed:
--
-- 1. It must contain EXACTLY ONE statement. `supabase db query --file`
--    sends the whole file as a prepared statement, and a second
--    top-level statement fails with the distinctly unhelpful "cannot
--    insert multiple commands into a prepared statement" (commit
--    f91a6c8). Add assertions INSIDE the DO block above; do not append
--    a second one.
--
-- 2. A RAISE in here really does fail the job. A deliberately false
--    assertion (commit 42c7db0, run 31579334056) surfaced as
--    `failed to execute query: error: ...` and exited 1. This is not a
--    decorative green tick.
