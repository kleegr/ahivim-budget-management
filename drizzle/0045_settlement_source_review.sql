-- Full refresh may finish processing a source version while particular sources
-- remain unresolved. Their existing obligation roots and correction descendants
-- stay blocked; unrelated known obligations may be actioned.
ALTER TABLE settlement_ledger_state
  ADD COLUMN IF NOT EXISTS blocked_obligation_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  ADD COLUMN IF NOT EXISTS source_review_count integer NOT NULL DEFAULT 0 CHECK (source_review_count >= 0),
  ADD COLUMN IF NOT EXISTS source_review_summary text;

-- Force one complete pass after upgrade so an old certification cannot bypass
-- the new per-obligation review gate. No obligation/event history is changed.
UPDATE settlement_ledger_state
   SET source_version = source_version + 1,
       dirty_since = COALESCE(dirty_since, now()),
       updated_at = now()
 WHERE singleton = true;

--> statement-breakpoint
-- Keep source-review holds authoritative even when an older application build
-- is restored. Existing events remain unchanged; only new money is guarded.
CREATE OR REPLACE FUNCTION guard_settlement_source_review_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  held_ids uuid[];
  source_batch_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('ahivim:settlement-ledger-source'));
  SELECT blocked_obligation_ids INTO held_ids
    FROM settlement_ledger_state WHERE singleton = true;
  IF held_ids IS NULL THEN
    RAISE EXCEPTION 'Settlement source-review state is unavailable.' USING ERRCODE = '23514';
  END IF;
  IF NEW.settlement_obligation_id = ANY(held_ids) THEN
    RAISE EXCEPTION 'Settlement source review must be resolved before recording activity.' USING ERRCODE = '23514';
  END IF;
  -- Reversing a transfer is one paired action. A rollback client must not
  -- reverse its clear side while the peer obligation remains on review hold.
  IF NEW.reversal_of_event_id IS NOT NULL THEN
    SELECT source.settlement_batch_id INTO source_batch_id
      FROM settlement_events source
      JOIN settlement_batches batch ON batch.id = source.settlement_batch_id
     WHERE source.id = NEW.reversal_of_event_id AND batch.action = 'apply_credit';
    IF source_batch_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM settlement_events peer
       WHERE peer.settlement_batch_id = source_batch_id
         AND peer.event_type = 'credit'
         AND peer.settlement_obligation_id = ANY(held_ids)
    ) THEN
      RAISE EXCEPTION 'The paired settlement source review must be resolved before reversing a credit.' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER settlement_events_source_review_guard
BEFORE INSERT ON settlement_events
FOR EACH ROW EXECUTE FUNCTION guard_settlement_source_review_event();
