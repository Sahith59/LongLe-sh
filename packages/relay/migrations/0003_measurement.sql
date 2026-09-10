-- Optional product measurement is separate from support content and encrypted relay rooms.
CREATE TABLE measurement_consent (
  account_key TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  granted_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE measurement_events (
  id TEXT PRIMARY KEY,
  account_key TEXT NOT NULL REFERENCES measurement_consent(account_key) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('paired','approval','reply','stop','handoff','tuning','delegation')),
  outcome TEXT NOT NULL CHECK(outcome IN ('success','failure','unknown')),
  occurred_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  build TEXT NOT NULL
);
CREATE INDEX measurement_events_received ON measurement_events(received_at);
CREATE INDEX measurement_events_account ON measurement_events(account_key, occurred_at);

CREATE TABLE measurement_daily (
  account_key TEXT NOT NULL REFERENCES measurement_consent(account_key) ON DELETE CASCADE,
  activity_day TEXT NOT NULL,
  paired INTEGER NOT NULL DEFAULT 0 CHECK(paired IN (0,1)),
  successful_actions INTEGER NOT NULL DEFAULT 0,
  failed_actions INTEGER NOT NULL DEFAULT 0,
  unknown_actions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(account_key, activity_day)
);
CREATE INDEX measurement_daily_day ON measurement_daily(activity_day);

CREATE TABLE measurement_daily_actions (
  account_key TEXT NOT NULL REFERENCES measurement_consent(account_key) ON DELETE CASCADE,
  activity_day TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('approval','reply','stop','handoff','tuning','delegation')),
  outcome TEXT NOT NULL CHECK(outcome IN ('success','failure','unknown')),
  event_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(account_key, activity_day, event_type, outcome)
);
CREATE INDEX measurement_daily_actions_day ON measurement_daily_actions(activity_day);

-- Aggregate in the same SQLite transaction as the idempotent raw insert. A Worker crash can
-- therefore neither lose an aggregate nor double-count one when the browser retries an event.
CREATE TRIGGER measurement_event_daily AFTER INSERT ON measurement_events BEGIN
  INSERT INTO measurement_daily(account_key, activity_day, paired, successful_actions, failed_actions, unknown_actions)
  VALUES (
    NEW.account_key,
    date(NEW.occurred_at / 1000, 'unixepoch'),
    CASE WHEN NEW.event_type = 'paired' AND NEW.outcome = 'success' THEN 1 ELSE 0 END,
    CASE WHEN NEW.event_type <> 'paired' AND NEW.outcome = 'success' THEN 1 ELSE 0 END,
    CASE WHEN NEW.event_type <> 'paired' AND NEW.outcome = 'failure' THEN 1 ELSE 0 END,
    CASE WHEN NEW.event_type <> 'paired' AND NEW.outcome = 'unknown' THEN 1 ELSE 0 END
  ) ON CONFLICT(account_key, activity_day) DO UPDATE SET
    paired = MAX(paired, excluded.paired),
    successful_actions = successful_actions + excluded.successful_actions,
    failed_actions = failed_actions + excluded.failed_actions,
    unknown_actions = unknown_actions + excluded.unknown_actions;
END;

CREATE TRIGGER measurement_event_action AFTER INSERT ON measurement_events
WHEN NEW.event_type <> 'paired' BEGIN
  INSERT INTO measurement_daily_actions(account_key, activity_day, event_type, outcome, event_count)
  VALUES (NEW.account_key, date(NEW.occurred_at / 1000, 'unixepoch'), NEW.event_type, NEW.outcome, 1)
  ON CONFLICT(account_key, activity_day, event_type, outcome)
  DO UPDATE SET event_count = event_count + 1;
END;
