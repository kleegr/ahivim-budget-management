CREATE UNIQUE INDEX IF NOT EXISTS "scheduled_sessions_one_transaction_match_key"
  ON "scheduled_sessions" USING btree ("matched_transaction_id")
  WHERE "matched_transaction_id" IS NOT NULL;
