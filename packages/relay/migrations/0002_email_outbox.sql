-- The trigger makes report receipt and its notification job one SQLite transaction.
-- No submission content, email address or access proof is copied from the report.
CREATE TABLE support_email_outbox (
  id TEXT PRIMARY KEY REFERENCES feedback(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  payload TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','accepted','review')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  lease_id TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  provider_id TEXT,
  reason TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX support_email_due ON support_email_outbox(state, next_attempt_at);
CREATE INDEX support_email_lease ON support_email_outbox(state, lease_until);
CREATE TRIGGER feedback_notification AFTER INSERT ON feedback BEGIN
  INSERT INTO support_email_outbox(id, created_at, next_attempt_at, updated_at)
    VALUES (NEW.id, NEW.created_at, NEW.created_at, NEW.created_at);
END;
