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
  expires_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX feedback_recent ON feedback(created_at DESC, id DESC);
CREATE INDEX feedback_expiry ON feedback(expires_at);
