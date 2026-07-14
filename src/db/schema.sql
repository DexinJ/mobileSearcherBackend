PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Users (authed only)
CREATE TABLE IF NOT EXISTS users (
  uid TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Trial devices (trialId)
CREATE TABLE IF NOT EXISTS trial_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trial_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- Conversations
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_type TEXT NOT NULL CHECK(owner_type IN ('user','trial')),
  owner_key TEXT NOT NULL,                -- firebase_uid OR trial_id
  model TEXT NOT NULL,
  language TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Messages (chat history)
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('system','user','assistant','tool')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

-- Daily usage for trial/users (token budgets)
CREATE TABLE IF NOT EXISTS usage_daily (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_type TEXT NOT NULL CHECK(owner_type IN ('user','trial')),
  owner_key TEXT NOT NULL,                -- firebase_uid OR trial_id
  day_key TEXT NOT NULL,                  -- 'YYYY-MM-DD' in server timezone
  tokens_used INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  UNIQUE(owner_type, owner_key, day_key)
);

CREATE INDEX IF NOT EXISTS idx_conversations_owner ON conversations(owner_type, owner_key, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
