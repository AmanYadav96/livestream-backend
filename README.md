# Livestream Backend

Node.js + Express + PostgreSQL + Socket.io backend for Live Chat, Notes, and Bible Integration.

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Copy env file and fill in your values
cp .env.example .env

# 3. Create the PostgreSQL database
createdb livestream_db

# 4. Run migrations
npm run migrate

# 5. Start development server
npm run dev
```

## API Overview

| Module   | Base Path      | Auth Required |
|----------|---------------|---------------|
| Auth     | /api/auth      | No (login/register) |
| Streams  | /api/streams   | Partial |
| Chat     | /api/chat      | Yes |
| Notes    | /api/notes     | Yes |
| Bible    | /api/bible     | Partial |

## Socket.io Events

**Client → Server**
- `chat:join` `{ streamId }` — join a stream room
- `chat:leave` `{ streamId }` — leave a stream room
- `chat:send` `{ streamId, content }` — send a message
- `chat:typing` `{ streamId }` — broadcast typing indicator

**Server → Client**
- `chat:message` — new message broadcast
- `chat:pinned` — a message was pinned
- `chat:unpinned` — message unpinned
- `chat:deleted` — message deleted
- `chat:user_muted` / `chat:user_unmuted`
- `bible:verse_pushed` — host pushed a verse to all viewers

## Get Your API.Bible Key
Register free at https://scripture.api.bible and paste the key into `.env` as `BIBLE_API_KEY`.
