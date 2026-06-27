import fs from "fs";
import Database from "better-sqlite3";
import { repoPath } from "../../repo-root.js";
import { initSchema } from "./schema.js";

const DB_PATH = repoPath("data", "scout.db");

/** @type {import("better-sqlite3").Database | null} */
let db = null;

/**
 * Open (once) the shared SQLite handle, create the data dir, apply PRAGMAs + schema.
 * better-sqlite3 is synchronous, so a single connection avoids WAL lock contention;
 * WAL mode lets readers proceed while a writer holds the lock briefly.
 * @returns {import("better-sqlite3").Database}
 */
export function initDb() {
  if (db) return db;
  fs.mkdirSync(repoPath("data"), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("foreign_keys = ON");
  initSchema(db);
  return db;
}

/** Get the shared handle. Throws if initDb() has not run. */
export function getDb() {
  if (!db) throw new Error("DB not initialized — call initDb() first");
  return db;
}

/** Close the handle (mainly for tests / clean shutdown). */
export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

export { DB_PATH };
