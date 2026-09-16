/**
 * Collaborators — the outside people on a deal, and which contacts they are on.
 *
 * WHY THEY ARE NOT TEAM MEMBERS, which is the whole reason this is a separate
 * table rather than more rows in `contact_assignments`. The Manage Team modal
 * says it plainly to the operator: "Making another user a team member gives them
 * the ability to view and edit this person's information." A team member is a
 * seat in this app. A collaborator is a lender, a title rep, a co-op agent —
 * someone on the transaction who must NEVER be handed access to Marco's CRM.
 * Storing them in the same table would make granting access the side effect of
 * recording who the lender is, and nothing in the UI would say so.
 *
 * WHY THEY WERE "NOT SYNCING". Brivity has 125 of them and they arrive on every
 * pull — `getBrivityPeople()` returns them with `recordKind: "collaborator"`.
 * The importer then deliberately drops them (`brivityImport.ts`: "`lead` is the
 * only Brivity type that is a contact"), and that decision is correct: a lender
 * imported as a lead lands on the call list and gets a nurture drip written for
 * buyers. So the records were never missing, they had nowhere to go. This is
 * the somewhere.
 *
 * The directory is a MIRROR of Brivity for the rows that came from there —
 * re-syncing updates them in place and never duplicates, matched on Brivity's
 * own id. Rows typed here are marked `manual` and a sync never touches them.
 */
import { randomUUID } from "crypto";
import { existsSync, mkdirSync } from "fs";
import path from "path";

import Database from "better-sqlite3";

function resolveCollaboratorDbPath(): string {
  const env = process.env.COLLABORATOR_DB_PATH?.trim();
  if (env) return env;
  if (existsSync("/data")) return "/data/collaborators.db";
  const localDir = path.join(process.cwd(), "data");
  mkdirSync(localDir, { recursive: true });
  return path.join(localDir, "collaborators.db");
}

let db: Database.Database | null = null;

function initCollaboratorSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS collaborators (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      company     TEXT,
      job_title   TEXT,
      email       TEXT,
      phone       TEXT,
      source      TEXT NOT NULL DEFAULT 'manual',
      brivity_id  TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    )
  `);
  database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_collab_brivity ON collaborators(brivity_id) WHERE brivity_id IS NOT NULL`);
  database.exec(`CREATE INDEX IF NOT EXISTS idx_collab_name ON collaborators(name)`);

  /* The link, kept separate from the directory so one lender can sit on many
     contacts without being retyped, and removing them from one deal does not
     delete the person. */
  database.exec(`
    CREATE TABLE IF NOT EXISTS collaborator_links (
      id              TEXT PRIMARY KEY,
      collaborator_id TEXT NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE,
      lead_id         TEXT NOT NULL,
      role_name       TEXT,
      created_at      TEXT NOT NULL,
      UNIQUE(collaborator_id, lead_id)
    )
  `);
  database.exec(`CREATE INDEX IF NOT EXISTS idx_collab_links_lead ON collaborator_links(lead_id)`);
}

export function getCollaboratorDb(): Database.Database {
  if (!db) {
    db = new Database(resolveCollaboratorDbPath());
    db.pragma("foreign_keys = ON");
    initCollaboratorSchema(db);
  }
  return db;
}

/** What a collaborator can be on a deal. Distinct from TEAM_ROLES, which grant access. */
export const COLLABORATOR_ROLES = [
  "Lender",
  "Title Company",
  "Escrow Officer",
  "Home Inspector",
  "Appraiser",
  "Insurance Agent",
  "Co-op Agent",
  "Attorney",
  "Contractor",
  "Photographer",
  "Other",
] as const;

export interface Collaborator {
  id: string;
  name: string;
  company: string | null;
  jobTitle: string | null;
  email: string | null;
  phone: string | null;
  /** `brivity` rows are a mirror and a re-sync updates them; `manual` is ours. */
  source: "brivity" | "manual";
  brivityId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CollaboratorLink extends Collaborator {
  linkId: string;
  leadId: string;
  roleName: string | null;
}

function rowToCollaborator(r: Record<string, unknown>): Collaborator {
  return {
    id: String(r.id),
    name: String(r.name),
    company: r.company == null ? null : String(r.company),
    jobTitle: r.job_title == null ? null : String(r.job_title),
    email: r.email == null ? null : String(r.email),
    phone: r.phone == null ? null : String(r.phone),
    source: (String(r.source) === "brivity" ? "brivity" : "manual"),
    brivityId: r.brivity_id == null ? null : String(r.brivity_id),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export function listCollaborators(search = "", limit = 500): Collaborator[] {
  const q = search.trim();
  const rows = q
    ? (getCollaboratorDb()
        .prepare(
          `SELECT * FROM collaborators
            WHERE name LIKE ? OR IFNULL(company,'') LIKE ? OR IFNULL(email,'') LIKE ?
            ORDER BY name COLLATE NOCASE ASC LIMIT ?`,
        )
        .all(`%${q}%`, `%${q}%`, `%${q}%`, limit) as Record<string, unknown>[])
    : (getCollaboratorDb()
        .prepare(`SELECT * FROM collaborators ORDER BY name COLLATE NOCASE ASC LIMIT ?`)
        .all(limit) as Record<string, unknown>[]);
  return rows.map(rowToCollaborator);
}

export function getCollaborator(id: string): Collaborator | null {
  const r = getCollaboratorDb().prepare(`SELECT * FROM collaborators WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return r ? rowToCollaborator(r) : null;
}

export interface CollaboratorInput {
  name: string;
  company?: string | null;
  jobTitle?: string | null;
  email?: string | null;
  phone?: string | null;
}

const clean = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : null;
};

/** Add one by hand, as the "Add Collaborator" button does. */
export function addCollaborator(input: CollaboratorInput): Collaborator {
  const name = (input.name || "").trim();
  if (!name) throw new Error("A collaborator needs a name");
  const now = new Date().toISOString();
  const id = randomUUID();
  getCollaboratorDb()
    .prepare(
      `INSERT INTO collaborators (id,name,company,job_title,email,phone,source,brivity_id,created_at,updated_at)
       VALUES (?,?,?,?,?,?,'manual',NULL,?,?)`,
    )
    .run(id, name, clean(input.company), clean(input.jobTitle), clean(input.email), clean(input.phone), now, now);
  return getCollaborator(id)!;
}

export function updateCollaborator(id: string, input: CollaboratorInput): Collaborator | null {
  const existing = getCollaborator(id);
  if (!existing) return null;
  const name = (input.name || "").trim() || existing.name;
  getCollaboratorDb()
    .prepare(
      `UPDATE collaborators SET name=?, company=?, job_title=?, email=?, phone=?, updated_at=? WHERE id=?`,
    )
    .run(name, clean(input.company), clean(input.jobTitle), clean(input.email), clean(input.phone), new Date().toISOString(), id);
  return getCollaborator(id);
}

/** Removing the person removes their links too (ON DELETE CASCADE). */
export function deleteCollaborator(id: string): boolean {
  return (getCollaboratorDb().prepare(`DELETE FROM collaborators WHERE id = ?`).run(id).changes ?? 0) > 0;
}

export interface BrivityCollaboratorSeed {
  brivityId: string;
  name: string;
  company: string | null;
  jobTitle: string | null;
  email: string | null;
  phone: string | null;
}

export interface CollaboratorSyncResult {
  seen: number;
  created: number;
  updated: number;
  skippedNoName: number;
}

/**
 * Bring Brivity's collaborator records into the directory.
 *
 * Matched on Brivity's own id so a re-sync updates in place and can never
 * duplicate. A row typed here (`manual`) is never touched, even if a Brivity
 * record looks like the same person — deciding two people are one is a merge,
 * and a sync is not the place to make that call silently.
 */
export function syncBrivityCollaborators(seeds: BrivityCollaboratorSeed[]): CollaboratorSyncResult {
  const d = getCollaboratorDb();
  const res: CollaboratorSyncResult = { seen: 0, created: 0, updated: 0, skippedNoName: 0 };
  const find = d.prepare(`SELECT id FROM collaborators WHERE brivity_id = ?`);
  const ins = d.prepare(
    `INSERT INTO collaborators (id,name,company,job_title,email,phone,source,brivity_id,created_at,updated_at)
     VALUES (?,?,?,?,?,?,'brivity',?,?,?)`,
  );
  const upd = d.prepare(
    `UPDATE collaborators SET name=?, company=?, job_title=?, email=?, phone=?, updated_at=?
      WHERE id=? AND source='brivity'`,
  );

  const run = d.transaction((rows: BrivityCollaboratorSeed[]) => {
    for (const s of rows) {
      res.seen++;
      const name = (s.name || "").trim();
      if (!name) { res.skippedNoName++; continue; }
      const now = new Date().toISOString();
      const hit = find.get(s.brivityId) as { id?: string } | undefined;
      if (hit?.id) {
        upd.run(name, clean(s.company), clean(s.jobTitle), clean(s.email), clean(s.phone), now, hit.id);
        res.updated++;
      } else {
        ins.run(randomUUID(), name, clean(s.company), clean(s.jobTitle), clean(s.email), clean(s.phone), s.brivityId, now, now);
        res.created++;
      }
    }
  });
  run(seeds);
  return res;
}

/* ───────────────────────── links to a contact ───────────────────────── */

export function listCollaboratorsForLead(leadId: string): CollaboratorLink[] {
  const rows = getCollaboratorDb()
    .prepare(
      `SELECT c.*, l.id AS link_id, l.lead_id, l.role_name
         FROM collaborator_links l JOIN collaborators c ON c.id = l.collaborator_id
        WHERE l.lead_id = ? ORDER BY c.name COLLATE NOCASE ASC`,
    )
    .all(leadId) as Record<string, unknown>[];
  return rows.map((r) => ({
    ...rowToCollaborator(r),
    linkId: String(r.link_id),
    leadId: String(r.lead_id),
    roleName: r.role_name == null ? null : String(r.role_name),
  }));
}

/**
 * Replace the whole collaborator list for one contact.
 *
 * Whole-set replacement, matching how the team modal already saves: the UI edits
 * a list and saves it once, and diffing on the client would let a row the
 * operator deleted survive a race with one they added. A collaborator id that
 * does not exist is skipped rather than throwing — one stale row must not lose
 * the operator the rest of their edit.
 */
export function setCollaboratorsForLead(
  leadId: string,
  entries: Array<{ collaboratorId: string; roleName?: string | null }>,
): CollaboratorLink[] {
  const d = getCollaboratorDb();
  const exists = d.prepare(`SELECT 1 FROM collaborators WHERE id = ?`);
  const tx = d.transaction(() => {
    d.prepare(`DELETE FROM collaborator_links WHERE lead_id = ?`).run(leadId);
    const ins = d.prepare(
      `INSERT OR IGNORE INTO collaborator_links (id,collaborator_id,lead_id,role_name,created_at)
       VALUES (?,?,?,?,?)`,
    );
    const now = new Date().toISOString();
    for (const e of entries) {
      const cid = (e.collaboratorId || "").trim();
      if (!cid || !exists.get(cid)) continue;
      ins.run(randomUUID(), cid, leadId, clean(e.roleName), now);
    }
  });
  tx();
  return listCollaboratorsForLead(leadId);
}

/** How many contacts each collaborator is on — shown in the directory. */
export function collaboratorLinkCounts(): Record<string, number> {
  const rows = getCollaboratorDb()
    .prepare(`SELECT collaborator_id, COUNT(*) AS n FROM collaborator_links GROUP BY collaborator_id`)
    .all() as Record<string, unknown>[];
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r.collaborator_id)] = Number(r.n ?? 0);
  return out;
}
