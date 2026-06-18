-- Laravel / Halobox app integration: map Laravel user & channel IDs

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS laravel_user_id VARCHAR(64) UNIQUE;

ALTER TABLE streams
  ADD COLUMN IF NOT EXISTS laravel_channel_id INTEGER UNIQUE;

-- System user for auto-provisioned live TV channel streams
INSERT INTO users (id, username, email, password, role, laravel_user_id)
VALUES (
  '00000000-0000-4000-a000-000000000001',
  'system',
  'system@halobox.local',
  'synced',
  'admin',
  '0'
)
ON CONFLICT (laravel_user_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_users_laravel_user_id ON users(laravel_user_id);
CREATE INDEX IF NOT EXISTS idx_streams_laravel_channel_id ON streams(laravel_channel_id);
