-- Schema für den Freundeskalender (Cloudflare D1 / SQLite)

CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  color      TEXT    NOT NULL DEFAULT '#1971c2',  -- Anzeigefarbe der Person
  token      TEXT    NOT NULL UNIQUE,  -- steckt im Einladungslink, gilt unbegrenzt
  ics_token  TEXT    NOT NULL UNIQUE,  -- geheimer Teil der persönlichen Abo-URL
  is_admin   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL,
  -- all_day = 0: 'YYYY-MM-DDTHH:MM:SSZ' (UTC) | all_day = 1: 'YYYY-MM-DD'
  starts_at   TEXT    NOT NULL,
  ends_at     TEXT,                     -- optional; bei all_day inklusiver letzter Tag
  all_day     INTEGER NOT NULL DEFAULT 0,
  location    TEXT,
  description TEXT,
  created_by  INTEGER NOT NULL REFERENCES users(id),
  revision    INTEGER NOT NULL DEFAULT 0, -- wird bei jeder Änderung erhöht (ICS SEQUENCE)
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS rsvps (
  event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     TEXT    NOT NULL CHECK (status IN ('yes','maybe','no')),
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_events_starts ON events(starts_at);
CREATE INDEX IF NOT EXISTS idx_rsvps_user    ON rsvps(user_id);
