-- Support content is deliberately separate from encrypted relay rooms and identity storage.
CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  access_hash TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('bug','feature','help')),
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  reply TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('received','needs_information','planned','resolved','not_planned')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER,
  expires_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX feedback_recent ON feedback(created_at DESC, id DESC);
CREATE INDEX feedback_expiry ON feedback(expires_at);

CREATE TABLE feedback_messages (
  id TEXT PRIMARY KEY,
  feedback_id TEXT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  author TEXT NOT NULL CHECK(author IN ('customer','owner')),
  body TEXT NOT NULL,
  status_snapshot TEXT NOT NULL CHECK(status_snapshot IN ('received','needs_information','planned','resolved','not_planned')),
  created_at INTEGER NOT NULL
);
CREATE INDEX feedback_messages_thread ON feedback_messages(feedback_id, created_at, id);
CREATE TRIGGER feedback_initial_message AFTER INSERT ON feedback BEGIN
  INSERT INTO feedback_messages(id, feedback_id, author, body, status_snapshot, created_at)
    VALUES ('initial:' || NEW.id, NEW.id, 'customer', NEW.message, NEW.status, NEW.created_at);
END;
