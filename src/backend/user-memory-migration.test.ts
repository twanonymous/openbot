// @vitest-environment node
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateOpenBotDatabase } from "./openbot-database-schema";

// Failure modes: the upgrade changes or loses a row of any table; a failed upgrade leaves a table or
// its marker; a newer or incomplete history is accepted; a user memory has a second owner, a bad
// origin or a duplicate text; the search index or the selection misses a row. These fixtures cover each.
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const NEW_TABLES = { projection_user_memories: [], user_memory_selections: [] };

function databaseAt(version: number): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  migrateUpTo(db, version);
  return db;
}

function migrateUpTo(db: DatabaseSync, version: number): void {
  db.exec(`CREATE TEMP TRIGGER stop_at_version BEFORE INSERT ON schema_migrations WHEN new.version > ${version}
    BEGIN SELECT RAISE(ABORT, 'fixture stop'); END;`);
  expect(() => migrateOpenBotDatabase(db)).toThrow(`migration to version ${version + 1} failed`);
  db.exec("DROP TRIGGER stop_at_version");
}

/** An agent memory, which every released schema has, and must keep. */
function seed(db: DatabaseSync): void {
  db.prepare(`INSERT INTO projection_agent_memories
    (memory_id, agent_id, text, normalized_text, origin, source_turn_id, created_at, updated_at, last_event_sequence)
    VALUES ('memory-1', 'chief', 'The build runs at night.', 'The build runs at night.', 'manual', NULL,
      '2026-01-01', '2026-01-01', 2)`).run();
}

function releasedDatabase(tag: string, marker: number): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(readFileSync(new URL(`./released-schemas/${tag}.sql`, import.meta.url), "utf8"));
  db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, '2026-01-01')").run(marker);
  db.prepare(`INSERT INTO projection_agents (agent_id, thread_id, model, updated_at, sort_order, agent_json,
    last_event_sequence) VALUES ('chief', 'openbot-thread-chief', 'gpt-5', '2026-01-01', 0,
    '{"id":"chief","name":"Chief"}', 1)`).run();
  return db;
}

/** Every row of every table, by table name. The search indexes are derived, so they are left out. */
function contents(db: DatabaseSync): Record<string, unknown[]> {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
       AND name <> 'schema_migrations' AND name NOT LIKE '%_memory_search%' ORDER BY name`,
    )
    .all()
    .map((row) => String(row.name));
  return Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM "${table}"`).all()]));
}

function userMemoryObjects(db: DatabaseSync) {
  return db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%user_memor%' ORDER BY name").all();
}

function expectHealthy(db: DatabaseSync): void {
  expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 47 });
  expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
}

const insertMemory = (db: DatabaseSync) =>
  db.prepare(`INSERT INTO projection_user_memories
    (memory_id, owner_id, text, normalized_text, origin, source_turn_id, created_at, updated_at, last_event_sequence)
    VALUES (?, ?, ?, ?, ?, NULL, '2026-01-01', '2026-01-01', 1)`);

describe("user memory migration", () => {
  it.each(Array.from({ length: 39 }, (_, index) => index + 8))(
    "preserves every row from released schema %i",
    (version) => {
      const db = databaseAt(version);
      seed(db);
      // The earlier migrations run first; the rows after them are what v47 must keep.
      if (version < 46) migrateUpTo(db, 46);
      const before = contents(db);
      migrateOpenBotDatabase(db);
      expect(contents(db)).toEqual({ ...before, ...NEW_TABLES });
      expectHealthy(db);
    },
  );

  it.each([
    ["v0.1.12", 3],
    ["v0.1.15", 4],
    ["v0.1.18", 4],
    ["v0.2.1", 6],
  ] as const)("preserves every row from the %s snapshot", (tag, marker) => {
    const db = releasedDatabase(tag, marker);
    migrateUpTo(db, 46);
    const before = contents(db);
    migrateOpenBotDatabase(db);
    expect(contents(db)).toEqual({ ...before, ...NEW_TABLES });
    expectHealthy(db);
  });

  it("rolls back the tables and the marker after a late failure, then retries", () => {
    const db = databaseAt(46);
    seed(db);
    const before = contents(db);
    db.exec(`CREATE TEMP TRIGGER fail_marker BEFORE INSERT ON schema_migrations WHEN new.version=47
      BEGIN SELECT RAISE(ABORT, 'late failure'); END;`);
    expect(() => migrateOpenBotDatabase(db)).toThrow("migration to version 47 failed");
    expect(contents(db)).toEqual(before);
    expect(userMemoryObjects(db)).toEqual([]);
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version=47").all()).toEqual([]);
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    db.exec("DROP TRIGGER fail_marker");
    migrateOpenBotDatabase(db);
    expect(contents(db)).toEqual({ ...before, ...NEW_TABLES });
    expectHealthy(db);
  });

  it("rejects newer and incomplete migration histories before it creates the tables", () => {
    const db = databaseAt(46);
    seed(db);
    const before = contents(db);
    db.exec("INSERT INTO schema_migrations VALUES(48,'now')");
    expect(() => migrateOpenBotDatabase(db)).toThrow("newer than this application supports");
    db.exec("DELETE FROM schema_migrations WHERE version=48; DELETE FROM schema_migrations WHERE version=20");
    expect(() => migrateOpenBotDatabase(db)).toThrow("missing version 20");
    expect(contents(db)).toEqual(before);
    expect(userMemoryObjects(db)).toEqual([]);
  });

  it("refuses a second owner, a bad origin and a repeated text, and indexes and selects each memory", () => {
    const db = databaseAt(46);
    migrateOpenBotDatabase(db);
    const insert = insertMemory(db);
    expect(() => insert.run("fact-1", "chief", "Kevin likes tea.", "Kevin likes tea.", "manual")).toThrow(
      "CHECK constraint failed",
    );
    expect(() => insert.run("fact-1", "user", "Kevin likes tea.", "Kevin likes tea.", "imported")).toThrow(
      "CHECK constraint failed",
    );
    insert.run("fact-1", "user", "Kevin likes tea.", "Kevin likes tea.", "manual");
    expect(() => insert.run("fact-2", "user", "Kevin likes tea.", "Kevin likes tea.", "automatic")).toThrow(
      "UNIQUE constraint failed",
    );
    insert.run("fact-2", "user", "Ana is Kevin's sister.", "Ana is Kevin's sister.", "automatic");
    expect(
      db.prepare("SELECT memory_id, inclusion, user_controlled, revision FROM user_memory_selections").all(),
    ).toEqual([
      { memory_id: "fact-1", inclusion: "searchable", user_controlled: 0, revision: 0 },
      { memory_id: "fact-2", inclusion: "searchable", user_controlled: 0, revision: 0 },
    ]);
    const search = (term: string) =>
      db
        .prepare(`SELECT m.memory_id FROM user_memory_search JOIN projection_user_memories m
          ON m.rowid = user_memory_search.rowid WHERE user_memory_search MATCH ?`)
        .all(term);
    expect(search('"tea"')).toEqual([{ memory_id: "fact-1" }]);
    db.prepare("UPDATE projection_user_memories SET text = 'Kevin likes coffee.' WHERE memory_id = 'fact-1'").run();
    expect(search('"tea"')).toEqual([]);
    expect(search('"coffee"')).toEqual([{ memory_id: "fact-1" }]);
    expect(db.prepare("SELECT revision FROM user_memory_selections WHERE memory_id = 'fact-1'").get()).toEqual({
      revision: 1,
    });
    db.prepare("DELETE FROM projection_user_memories WHERE memory_id = 'fact-1'").run();
    expect(search('"coffee"')).toEqual([]);
    expect(db.prepare("SELECT memory_id FROM user_memory_selections").all()).toEqual([{ memory_id: "fact-2" }]);
    expectHealthy(db);
  });
});
