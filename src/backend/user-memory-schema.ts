// Shared by migration v47 and the separate new-database schema. IF NOT EXISTS throughout.
//
// What the user tells any agent about themselves: their name, people, preferences and routines. One
// owner, the user, so every agent of this computer reads the same rows. The columns mirror
// `projection_agent_memories`, because one store implementation serves every owner, and the selection
// table, search index and triggers mirror `AGENT_MEMORY_SELECTION_SCHEMA_SQL` for the same reason.
// `owner_id` has one value; the column exists so the shared store can address it like any other owner.

/** The one owner of every user memory. */
export const USER_MEMORY_OWNER = "user";

export const USER_MEMORY_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS projection_user_memories (
    memory_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL CHECK(owner_id = '${USER_MEMORY_OWNER}'),
    text TEXT NOT NULL,
    normalized_text TEXT NOT NULL,
    origin TEXT NOT NULL CHECK(origin IN ('automatic', 'manual')),
    source_turn_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_event_sequence INTEGER NOT NULL,
    UNIQUE(owner_id, normalized_text)
  );
  CREATE INDEX IF NOT EXISTS user_memories_owner
    ON projection_user_memories(owner_id, updated_at DESC, memory_id);
  CREATE TABLE IF NOT EXISTS user_memory_selections (
    memory_id TEXT PRIMARY KEY REFERENCES projection_user_memories(memory_id) ON DELETE CASCADE,
    inclusion TEXT NOT NULL DEFAULT 'searchable' CHECK(inclusion IN ('essential', 'searchable')),
    user_controlled INTEGER NOT NULL DEFAULT 0 CHECK(user_controlled IN (0, 1)),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0)
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS user_memory_search USING fts5(
    text, content='projection_user_memories', content_rowid='rowid', tokenize='unicode61'
  );
  CREATE TRIGGER IF NOT EXISTS user_memory_insert AFTER INSERT ON projection_user_memories BEGIN
    INSERT INTO user_memory_selections(memory_id) VALUES (new.memory_id);
    INSERT INTO user_memory_search(rowid, text) VALUES (new.rowid, new.text);
  END;
  CREATE TRIGGER IF NOT EXISTS user_memory_update AFTER UPDATE ON projection_user_memories BEGIN
    INSERT INTO user_memory_search(user_memory_search, rowid, text) VALUES ('delete', old.rowid, old.text);
    INSERT INTO user_memory_search(rowid, text) VALUES (new.rowid, new.text);
    UPDATE user_memory_selections SET revision = revision + 1 WHERE memory_id = new.memory_id;
  END;
  CREATE TRIGGER IF NOT EXISTS user_memory_delete AFTER DELETE ON projection_user_memories BEGIN
    INSERT INTO user_memory_search(user_memory_search, rowid, text) VALUES ('delete', old.rowid, old.text);
  END;
`;
