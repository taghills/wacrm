-- ============================================================
-- 050_flow_set_store_node.sql — the 'set_store' flow node
--
-- Lets a Flow link the contact to a store: the customer picks their
-- branch from a button menu on their first message, and that pick
-- writes `contact_stores` with source = 'bot' (migration 043).
--
-- Why this needs a migration at all
--
--   `flow_nodes.node_type` carries a CHECK constraint listing every
--   node type the engine understands. Without adding the value here,
--   saving a flow containing the new node fails at the database with
--   a constraint violation — the node would exist in the builder and
--   be unsaveable. Migration 016 added 'send_media' the same way;
--   this follows that precedent exactly.
--
--   The node's CONFIG shape (store_id, next_node_key) lives in JSONB
--   and is checked by the TypeScript types and the flow validator,
--   not by the database — same split as every other node type.
--
-- What this does NOT do
--
--   It grants nothing and changes no policy. Writing contact_stores
--   already requires passing that table's existing RLS, and the
--   engine runs as the service role with an explicit account check
--   (see src/lib/flows/set-store.ts) rather than relying on it.
--
-- Idempotent — the constraint is dropped and recreated.
-- ============================================================

ALTER TABLE flow_nodes
  DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;

ALTER TABLE flow_nodes
  ADD CONSTRAINT flow_nodes_node_type_check
  CHECK (node_type IN (
    'start',
    'send_buttons',
    'send_list',
    'send_message',
    'send_media',
    'collect_input',
    'condition',
    'set_tag',
    'set_store',
    'handoff',
    'http_fetch',
    'end'
  ));
