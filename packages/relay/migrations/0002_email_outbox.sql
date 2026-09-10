-- The trigger makes report receipt and its notification job one SQLite transaction.
-- No submission content, email address or access proof is copied from the report.
CREATE TABLE support_email_outbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'new_feedback' CHECK(kind IN ('new_feedback','email_test','weekly_digest')),
  feedback_id TEXT REFERENCES feedback(id) ON DELETE CASCADE,
  dedupe_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  payload TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','accepted','review')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  lease_id TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  provider_id TEXT,
  delivery_state TEXT NOT NULL DEFAULT 'unconfirmed' CHECK(delivery_state IN ('unconfirmed','sent','delivered','delayed','failed','bounced','complained','suppressed')),
  delivery_updated_at INTEGER,
  reason TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX support_email_due ON support_email_outbox(state, next_attempt_at);
CREATE INDEX support_email_lease ON support_email_outbox(state, lease_until);
CREATE INDEX support_email_provider ON support_email_outbox(provider_id);

CREATE TABLE support_email_webhook_events (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX support_email_webhook_received ON support_email_webhook_events(received_at);
CREATE TRIGGER feedback_notification AFTER INSERT ON feedback BEGIN
  INSERT INTO support_email_outbox(id, kind, feedback_id, dedupe_key, created_at, next_attempt_at, updated_at)
    VALUES (NEW.id, 'new_feedback', NEW.id, 'feedback:' || NEW.id, NEW.created_at, NEW.created_at, NEW.created_at);
END;
