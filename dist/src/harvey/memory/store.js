"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getMemoryDb = getMemoryDb;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
function resolveMemoryDbPath() {
    if ((0, fs_1.existsSync)("/data"))
        return "/data/harvey-memory.db";
    const localDir = path_1.default.join(process.cwd(), "data");
    (0, fs_1.mkdirSync)(localDir, { recursive: true });
    return path_1.default.join(localDir, "harvey-memory.db");
}
let db = null;
function initSchema(database) {
    database.exec(`
    CREATE TABLE IF NOT EXISTS harvey_episodes (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      timestamp TEXT,
      summary TEXT,
      people_involved TEXT,
      emotional_weight TEXT DEFAULT 'routine',
      topics TEXT,
      raw_turns INTEGER DEFAULT 0,
      weight REAL DEFAULT 1.0
    );

    CREATE TABLE IF NOT EXISTS harvey_semantic (
      id TEXT PRIMARY KEY,
      fact TEXT,
      category TEXT,
      tags TEXT,
      confidence REAL DEFAULT 1.0,
      access_count INTEGER DEFAULT 0,
      last_accessed TEXT,
      created_at TEXT,
      superseded_by TEXT,
      weight REAL DEFAULT 1.0
    );

    CREATE TABLE IF NOT EXISTS harvey_relational (
      id TEXT PRIMARY KEY,
      entity_a TEXT,
      relationship TEXT,
      entity_b TEXT,
      weight REAL DEFAULT 1.0,
      created_at TEXT,
      last_reinforced TEXT
    );

    CREATE TABLE IF NOT EXISTS harvey_procedural (
      id TEXT PRIMARY KEY,
      trigger_condition TEXT,
      action TEXT,
      category TEXT,
      use_count INTEGER DEFAULT 0,
      created_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_semantic_category ON harvey_semantic(category);
    CREATE INDEX IF NOT EXISTS idx_semantic_weight ON harvey_semantic(weight DESC);
    CREATE INDEX IF NOT EXISTS idx_relational_entity_a ON harvey_relational(entity_a);
    CREATE INDEX IF NOT EXISTS idx_episodes_timestamp ON harvey_episodes(timestamp DESC);
  `);
}
function getMemoryDb() {
    if (db)
        return db;
    const dbPath = resolveMemoryDbPath();
    (0, fs_1.mkdirSync)(path_1.default.dirname(dbPath), { recursive: true });
    db = new better_sqlite3_1.default(dbPath);
    db.pragma("journal_mode = WAL");
    initSchema(db);
    return db;
}
