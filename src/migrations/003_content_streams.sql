-- VOD content streams (movies, TV episodes, videos) for notes & chat rooms

ALTER TABLE streams
  ADD COLUMN IF NOT EXISTS content_key VARCHAR(64) UNIQUE;

CREATE INDEX IF NOT EXISTS idx_streams_content_key ON streams(content_key);
