-- Brick After Dark leaderboard schema for Cloudflare D1 (SQLite).
-- Apply with: npx wrangler d1 execute brick-after-dark-scores --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS scores (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL CHECK (length(name) BETWEEN 2 AND 16 AND name = trim(name)),
  score       INTEGER NOT NULL CHECK (score BETWEEN 0 AND 3000000),
  distance    INTEGER NOT NULL CHECK (distance BETWEEN 0 AND 500000),
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  -- score = distance + 25 per brick pickup; pickups are capped at 3 per 24m wave.
  CHECK (score >= distance AND score <= distance * 5 + 200 AND (score - distance) % 25 = 0)
);

CREATE INDEX IF NOT EXISTS scores_score_desc_idx ON scores (score DESC, distance DESC);

-- Per-IP submit throttle. Stores a salted SHA-256 hash of the IP, never the raw address.
CREATE TABLE IF NOT EXISTS rate_limits (
  ip_hash  TEXT    PRIMARY KEY,
  last_at  INTEGER NOT NULL
);
