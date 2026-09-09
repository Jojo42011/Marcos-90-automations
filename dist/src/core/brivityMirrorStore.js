"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBrivityMirrorDb = getBrivityMirrorDb;
exports.replaceBrivityMirror = replaceBrivityMirror;
exports.recordBrivitySyncFailure = recordBrivitySyncFailure;
exports.readBrivityMirror = readBrivityMirror;
exports.getBrivityMirrorStatus = getBrivityMirrorStatus;
exports.brivityMirrorSourceCounts = brivityMirrorSourceCounts;
exports.closeBrivityMirrorDb = closeBrivityMirrorDb;
/**
 * A durable local mirror of Brivity's contact list.
 *
 * WHY THIS EXISTS. Brivity's people list was held in a 10-minute in-memory
 * cache and nowhere else. Two consequences, both of which Marco hit:
 *
 *   1. Every cold load paid the full round trip. Pulling all ~2,900 contacts
 *      MEASURES 25-30 SECONDS against the real account, and until it returned
 *      the CRM had nothing to show. Restart the server, or leave the tab shut
 *      for ten minutes, and you paid it again.
 *   2. Nothing survived a restart. "Every time we reload, the leads don't go
 *      away" was the requirement, and an in-memory Map cannot meet it — a Fly
 *      deploy or an idle machine reclaim emptied it.
 *
 * So the pull is now written to SQLite on the /data volume and READ FROM THERE.
 * The network fetch becomes a background refresh rather than something a page
 * load waits on: the CRM gets the last known good list instantly, and the list
 * gets newer on its own.
 *
 * THIS IS A MIRROR, NOT THE SYSTEM OF RECORD. Brivity owns these rows. This
 * table is a cache that happens to be durable, and it is safe to delete — the
 * next refresh rebuilds it. That is deliberately different from an *imported*
 * lead, which is a real CRM record in the lead store that Marco can edit, tag
 * and assign. Importing is what `brivityImport.ts` does; mirroring is what this
 * does, and conflating the two would mean a Brivity edit silently reverting
 * something typed here.
 *
 * WHAT IS STORED. The mapped `BrivityLeadRow` as JSON, plus the handful of
 * columns worth querying and indexing on their own (phone/email for matching,
 * source for the sidebar counts, record kind for holding non-leads back). The
 * blob keeps the store honest as `BrivityLeadRow` grows — a new field needs no
 * migration and cannot be silently dropped on the way through.
 *
 * ALSO: WHY THERE IS NO TRANSACTIONS TABLE HERE. Marco asked for "everything
 * else we are able to pull". Measured against the live account, `/api/people`
 * is the ONLY endpoint Brivity's integration API serves — `/api/users`,
 * `/api/tags`, `/api/tasks` and friends all return the identical
 * `{"status":"406","error":"Not Acceptable"}` as a route that does not exist at
 * all, which is how we know they are absent rather than broken. There is
 * nothing else to mirror; a table for it would be a promise the API cannot
 * keep. See FORAI [2026-08-31c].
 */
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
function resolveBase() {
    const base = (0, fs_1.existsSync)("/data") ? "/data" : path_1.default.join(process.cwd(), "data");
    (0, fs_1.mkdirSync)(base, { recursive: true });
    return base;
}
function resolveDbPath() {
    return process.env.BRIVITY_MIRROR_DB_PATH?.trim() || path_1.default.join(resolveBase(), "brivity-mirror.db");
}
let db = null;
function getBrivityMirrorDb() {
    if (db)
        return db;
    db = new better_sqlite3_1.default(resolveDbPath());
    db.pragma("journal_mode = WAL");
    db.exec(`
    CREATE TABLE IF NOT EXISTS brivity_people (
      brivity_id  TEXT PRIMARY KEY,
      phone_key   TEXT NOT NULL DEFAULT '',
      email_key   TEXT NOT NULL DEFAULT '',
      source      TEXT NOT NULL DEFAULT '',
      record_kind TEXT NOT NULL DEFAULT 'lead',
      crm_status  TEXT NOT NULL DEFAULT '',
      name        TEXT NOT NULL DEFAULT '',
      row         TEXT NOT NULL,
      synced_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bp_phone  ON brivity_people(phone_key);
    CREATE INDEX IF NOT EXISTS idx_bp_email  ON brivity_people(email_key);
    CREATE INDEX IF NOT EXISTS idx_bp_source ON brivity_people(source);

    /* One row per completed sync. Keeping the history rather than a single
       mutable row means "when did this last actually work" survives a failure,
       which is the question asked when the board looks stale. */
    CREATE TABLE IF NOT EXISTS brivity_sync_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      ok         INTEGER NOT NULL,
      row_count  INTEGER NOT NULL DEFAULT 0,
      error      TEXT
    );
  `);
    return db;
}
/** US 10-digit, matching brivityImport's `phoneKey` so the two agree. */
function phoneKey(raw) {
    let d = String(raw ?? "").replace(/\D/g, "");
    if (d.length === 11 && d.startsWith("1"))
        d = d.slice(1);
    return d.length === 10 ? d : "";
}
function emailKey(raw) {
    return String(raw ?? "").trim().toLowerCase();
}
/**
 * Replace the mirror with a fresh pull.
 *
 * A full replace inside one transaction, not an incremental merge: Brivity
 * returns no timestamps, so there is no way to tell a changed row from an
 * unchanged one, and no way to learn that a contact was DELETED there other
 * than its absence from a complete list. Upserting alone would accumulate
 * contacts Brivity no longer has, forever.
 *
 * Refuses an empty list. `getBrivityPeople()` degrades to `[]` on a failed
 * fetch, and writing that would wipe a good mirror because the network blipped.
 */
function replaceBrivityMirror(rows, startedAt) {
    if (!rows.length)
        throw new Error("refusing to replace the Brivity mirror with an empty result");
    const d = getBrivityMirrorDb();
    const now = new Date().toISOString();
    const insert = d.prepare(`INSERT INTO brivity_people
       (brivity_id, phone_key, email_key, source, record_kind, crm_status, name, row, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const run = d.transaction((list) => {
        d.prepare("DELETE FROM brivity_people").run();
        for (const r of list) {
            const id = String(r.brivityId || r.id || "");
            if (!id)
                continue;
            insert.run(id, phoneKey(r.phone), emailKey(r.email), String(r.source || ""), String(r.recordKind || "lead"), String(r.crmStatus || ""), String(r.name || ""), JSON.stringify(r), now);
        }
    });
    run(rows);
    d.prepare(`INSERT INTO brivity_sync_log (started_at, finished_at, ok, row_count, error)
     VALUES (?, ?, 1, ?, NULL)`).run(startedAt, now, rows.length);
    return rows.length;
}
/** Record a failed refresh without touching the rows we already hold. */
function recordBrivitySyncFailure(startedAt, error) {
    const d = getBrivityMirrorDb();
    d.prepare(`INSERT INTO brivity_sync_log (started_at, finished_at, ok, row_count, error)
     VALUES (?, ?, 0, 0, ?)`).run(startedAt, new Date().toISOString(), error.slice(0, 500));
}
/** Everything the mirror holds, in the same shape the live fetch returns. */
function readBrivityMirror() {
    const d = getBrivityMirrorDb();
    const rows = d.prepare("SELECT row FROM brivity_people").all();
    const out = [];
    for (const r of rows) {
        try {
            out.push(JSON.parse(r.row));
        }
        catch {
            /* A single unparseable blob must not take the whole list down — the rest
               of the mirror is still good, and the next sync rewrites this row. */
        }
    }
    return out;
}
function getBrivityMirrorStatus() {
    const d = getBrivityMirrorDb();
    const count = d.prepare("SELECT COUNT(*) AS n FROM brivity_people").get().n;
    const lastOk = d
        .prepare("SELECT finished_at FROM brivity_sync_log WHERE ok = 1 ORDER BY id DESC LIMIT 1")
        .get();
    const last = d
        .prepare("SELECT finished_at, ok, error FROM brivity_sync_log ORDER BY id DESC LIMIT 1")
        .get();
    return {
        count,
        lastSyncedAt: lastOk?.finished_at ?? null,
        /* Only surfaced when the LAST attempt failed. An old failure followed by a
           success is not something to keep warning about. */
        lastError: last && !last.ok ? last.error : null,
        lastAttemptAt: last?.finished_at ?? null,
    };
}
/** Source → count, for the CRM's sidebar. Computed in SQL over the whole mirror. */
function brivityMirrorSourceCounts() {
    const d = getBrivityMirrorDb();
    return d
        .prepare(`SELECT source, COUNT(*) AS n FROM brivity_people
        WHERE source <> '' GROUP BY source ORDER BY n DESC`)
        .all();
}
/** Test seam: drop the handle so a suite can point at a fresh file. */
function closeBrivityMirrorDb() {
    try {
        db?.close();
    }
    catch {
        /* already closed */
    }
    db = null;
}
