-- =============================================================
--  Livestream Backend — Initial Schema
--  Features: Live Chat, Notes, Bible Integration
-- =============================================================

-- UUIDs use gen_random_uuid() (built-in on PostgreSQL 13+, no extension required)

-- -------------------------------------------------------------
-- USERS
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username     VARCHAR(50)  NOT NULL UNIQUE,
  email        VARCHAR(255) NOT NULL UNIQUE,
  password     VARCHAR(255) NOT NULL,
  avatar_url   TEXT,
  role         VARCHAR(20)  NOT NULL DEFAULT 'viewer'
                CHECK (role IN ('viewer', 'host', 'admin')),
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email    ON users(email);
CREATE INDEX idx_users_username ON users(username);

-- -------------------------------------------------------------
-- STREAMS
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS streams (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id      UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        VARCHAR(255) NOT NULL,
  description  TEXT,
  is_live      BOOLEAN      NOT NULL DEFAULT FALSE,
  started_at   TIMESTAMPTZ,
  ended_at     TIMESTAMPTZ,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_streams_host_id ON streams(host_id);
CREATE INDEX idx_streams_is_live ON streams(is_live);

-- -------------------------------------------------------------
-- LIVE CHAT
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_messages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id    UUID         NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  user_id      UUID         NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  content      TEXT         NOT NULL CHECK (char_length(content) <= 500),
  is_pinned    BOOLEAN      NOT NULL DEFAULT FALSE,
  is_deleted   BOOLEAN      NOT NULL DEFAULT FALSE,
  deleted_by   UUID         REFERENCES users(id),
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_chat_messages_stream_id  ON chat_messages(stream_id);
CREATE INDEX idx_chat_messages_user_id    ON chat_messages(user_id);
CREATE INDEX idx_chat_messages_created_at ON chat_messages(created_at DESC);
CREATE INDEX idx_chat_messages_pinned     ON chat_messages(stream_id, is_pinned)
  WHERE is_pinned = TRUE;

-- Muted users per stream
CREATE TABLE IF NOT EXISTS muted_users (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id    UUID         NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  user_id      UUID         NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  muted_by     UUID         NOT NULL REFERENCES users(id),
  muted_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE(stream_id, user_id)
);

CREATE INDEX idx_muted_users_stream ON muted_users(stream_id, user_id);

-- -------------------------------------------------------------
-- NOTES
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID         NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  stream_id        UUID         REFERENCES streams(id)           ON DELETE SET NULL,
  content          TEXT         NOT NULL,
  stream_timestamp INTEGER,           -- seconds into the stream when note was written
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notes_user_id   ON notes(user_id);
CREATE INDEX idx_notes_stream_id ON notes(stream_id);
CREATE INDEX idx_notes_created   ON notes(user_id, created_at DESC);

-- -------------------------------------------------------------
-- BIBLE — SAVED VERSES
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saved_verses (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verse_id     VARCHAR(100) NOT NULL,    -- API.Bible verse ID e.g. "JHN.3.16"
  reference    VARCHAR(100) NOT NULL,    -- Human-readable e.g. "John 3:16"
  text         TEXT         NOT NULL,
  translation  VARCHAR(20)  NOT NULL DEFAULT 'KJV',
  bible_id     VARCHAR(100) NOT NULL,    -- API.Bible bible ID
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, verse_id, bible_id)
);

CREATE INDEX idx_saved_verses_user ON saved_verses(user_id);

-- Bible API cache (reduces external API calls)
CREATE TABLE IF NOT EXISTS bible_cache (
  cache_key    VARCHAR(500) PRIMARY KEY,
  data         JSONB        NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ  NOT NULL DEFAULT (NOW() + INTERVAL '24 hours')
);

CREATE INDEX idx_bible_cache_expires ON bible_cache(expires_at);

-- Pushed verses (host broadcasts a verse to all viewers in a stream)
CREATE TABLE IF NOT EXISTS pushed_verses (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id    UUID         NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  pushed_by    UUID         NOT NULL REFERENCES users(id),
  verse_id     VARCHAR(100) NOT NULL,
  reference    VARCHAR(100) NOT NULL,
  text         TEXT         NOT NULL,
  translation  VARCHAR(20)  NOT NULL,
  bible_id     VARCHAR(100) NOT NULL,
  pushed_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pushed_verses_stream ON pushed_verses(stream_id);

-- -------------------------------------------------------------
-- UTILITY — auto-update updated_at
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_notes_updated_at
  BEFORE UPDATE ON notes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
