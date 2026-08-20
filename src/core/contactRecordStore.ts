/**
 * The contact record's own data: emails, phones, addresses, social links,
 * notes and documents for one CRM contact.
 *
 * WHY A SEPARATE STORE. A Lead already carries ONE `email`, ONE `phone` and
 * ONE `address` string, and those stay exactly where they are — they are what
 * the DM pipeline writes, what the lead table sorts on, and what every existing
 * automation reads. What the contact record needs is different: a person has a
 * personal address and a work address, a mobile that can be texted and a home
 * line that is on the Do Not Call list. That is a one-to-many relationship, and
 * squeezing it into the single-value columns would have quietly broken the
 * table, the filters and the senders all at once.
 *
 * So the rule this file follows: the Lead's own `email`/`phone`/`address` are
 * the PRIMARY, and the rows here are the full set. Marking a row primary writes
 * back to the Lead (see server.ts) so there is exactly one answer to "what
 * number do we call", and nothing downstream has to learn a new shape.
 *
 * DNC IS NOT DECORATION. `dnc` on a phone row is a legal flag, so it is stored
 * on the row, shown on the row, and never inferred. A number nobody has checked
 * is `dnc = 0` meaning "not marked", not "cleared to call" — the UI says as
 * much rather than implying a check happened.
 *
 * DOCUMENTS ARE FILES ON DISK, not blobs in SQLite. The row holds the metadata
 * and a path under /data/contact-docs; the bytes stay on the volume, which is
 * what the rest of this system does with uploads and what keeps the database
 * small enough to stay fast.
 */
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, rmSync } from "fs";
import path from "path";

import Database from "better-sqlite3";

/* ────────────────────────── shapes ────────────────────────── */

export type EmailKind = "personal" | "work" | "other";
export type PhoneKind = "mobile" | "home" | "work" | "other";
export type AddressKind = "home" | "work" | "mailing" | "other";

export interface ContactEmail {
  id: string;
  leadId: string;
  address: string;
  kind: EmailKind;
  isPrimary: boolean;
  createdAt: string;
}

export interface ContactPhone {
  id: string;
  leadId: string;
  number: string;
  kind: PhoneKind;
  /** Marked Do Not Call by a human. Never derived. */
  dnc: boolean;
  isPrimary: boolean;
  createdAt: string;
}

export interface ContactAddress {
  id: string;
  leadId: string;
  kind: AddressKind;
  street: string;
  apt: string;
  city: string;
  /** State / province code, as chosen for the selected country. */
  region: string;
  /** ISO-3166 alpha-2. Only US and CA have locale data below. */
  country: string;
  postalCode: string;
  createdAt: string;
}

/** Platforms the Social Media block edits, in the order the block renders. */
export const SOCIAL_PLATFORMS = [
  "facebook",
  "x",
  "linkedin",
  "instagram",
  "youtube",
  "tiktok",
  "pinterest",
] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export interface ContactSocialLink {
  leadId: string;
  platform: SocialPlatform;
  url: string;
  updatedAt: string;
}

export interface NoteMention {
  memberId: string;
  memberName: string;
}

export interface ContactNote {
  id: string;
  leadId: string;
  body: string;
  /** "Notes are hidden from viewers" — true keeps this note off client-facing views. */
  hiddenFromViewers: boolean;
  /** The importance star. */
  important: boolean;
  author: string;
  mentions: NoteMention[];
  createdAt: string;
}

export interface ContactDocument {
  id: string;
  leadId: string;
  docType: string;
  fileName: string;
  mime: string;
  bytes: number;
  storedPath: string;
  signedDate: string | null;
  expirationDate: string | null;
  /** Set when the upload also opened a pipeline transaction. */
  transactionId: string | null;
  createdAt: string;
}

export interface ContactRecord {
  emails: ContactEmail[];
  phones: ContactPhone[];
  addresses: ContactAddress[];
  social: ContactSocialLink[];
  notes: ContactNote[];
  documents: ContactDocument[];
}

/* ────────────────────────── database ────────────────────────── */

function resolveBase(): string {
  const base = existsSync("/data") ? "/data" : path.join(process.cwd(), "data");
  mkdirSync(base, { recursive: true });
  return base;
}

function resolveDbPath(): string {
  return process.env.CONTACT_RECORD_DB_PATH?.trim() || path.join(resolveBase(), "contact-records.db");
}

export function resolveContactDocsDir(): string {
  const dir = process.env.CONTACT_DOCS_DIR?.trim() || path.join(resolveBase(), "contact-docs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

let db: Database.Database | null = null;

export function getContactRecordDb(): Database.Database {
  if (db) return db;
  db = new Database(resolveDbPath());
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS contact_emails (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL,
      address TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'personal',
      is_primary INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_contact_emails_lead ON contact_emails(lead_id);

    CREATE TABLE IF NOT EXISTS contact_phones (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL,
      number TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'mobile',
      dnc INTEGER NOT NULL DEFAULT 0,
      is_primary INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_contact_phones_lead ON contact_phones(lead_id);

    CREATE TABLE IF NOT EXISTS contact_addresses (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'home',
      street TEXT NOT NULL DEFAULT '',
      apt TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '',
      region TEXT NOT NULL DEFAULT '',
      country TEXT NOT NULL DEFAULT 'US',
      postal_code TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_contact_addresses_lead ON contact_addresses(lead_id);

    CREATE TABLE IF NOT EXISTS contact_social_links (
      lead_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      url TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (lead_id, platform)
    );

    CREATE TABLE IF NOT EXISTS contact_notes (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL,
      body TEXT NOT NULL,
      hidden_from_viewers INTEGER NOT NULL DEFAULT 1,
      important INTEGER NOT NULL DEFAULT 0,
      author TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_contact_notes_lead ON contact_notes(lead_id, created_at);

    CREATE TABLE IF NOT EXISTS note_mentions (
      id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL,
      lead_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      member_name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_note_mentions_note ON note_mentions(note_id);
    CREATE INDEX IF NOT EXISTS idx_note_mentions_member ON note_mentions(member_id);

    CREATE TABLE IF NOT EXISTS contact_documents (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL,
      doc_type TEXT NOT NULL DEFAULT 'other',
      file_name TEXT NOT NULL,
      mime TEXT NOT NULL DEFAULT 'application/octet-stream',
      bytes INTEGER NOT NULL DEFAULT 0,
      stored_path TEXT NOT NULL,
      signed_date TEXT,
      expiration_date TEXT,
      transaction_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_contact_documents_lead ON contact_documents(lead_id, created_at);
  `);
  return db;
}

const nowIso = () => new Date().toISOString();
const bool = (v: unknown) => (v ? 1 : 0);

/* ────────────────────────── normalisers ────────────────────────── */

const EMAIL_KINDS = new Set<EmailKind>(["personal", "work", "other"]);
const PHONE_KINDS = new Set<PhoneKind>(["mobile", "home", "work", "other"]);
const ADDRESS_KINDS = new Set<AddressKind>(["home", "work", "mailing", "other"]);
const SOCIAL_SET = new Set<string>(SOCIAL_PLATFORMS);

export function normEmailKind(v: unknown): EmailKind {
  return typeof v === "string" && EMAIL_KINDS.has(v as EmailKind) ? (v as EmailKind) : "personal";
}
export function normPhoneKind(v: unknown): PhoneKind {
  return typeof v === "string" && PHONE_KINDS.has(v as PhoneKind) ? (v as PhoneKind) : "mobile";
}
export function normAddressKind(v: unknown): AddressKind {
  return typeof v === "string" && ADDRESS_KINDS.has(v as AddressKind) ? (v as AddressKind) : "home";
}

/**
 * "(817) 995-4677" for a 10-digit US number, "+1 (817) 995-4677" for an
 * 11-digit one starting with 1. Anything else is kept exactly as typed —
 * an international number mangled into a US shape is worse than an unformatted
 * one, because it looks correct and does not dial.
 */
export function formatUsPhone(raw: string): string {
  const trimmed = (raw || "").trim();
  const digits = trimmed.replace(/\D/g, "");
  if (/^\+/.test(trimmed) && !/^\+1/.test(trimmed)) return trimmed;
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits.startsWith("1"))
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  return trimmed;
}

/** ISO YYYY-MM-DD, or null. Junk is null rather than a silently wrong date. */
export function normDay(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/* ────────────────────────── emails ────────────────────────── */

type EmailRow = {
  id: string; lead_id: string; address: string; kind: string; is_primary: number; created_at: string;
};
const toEmail = (r: EmailRow): ContactEmail => ({
  id: r.id, leadId: r.lead_id, address: r.address, kind: normEmailKind(r.kind),
  isPrimary: !!r.is_primary, createdAt: r.created_at,
});

export function listEmails(leadId: string): ContactEmail[] {
  return (getContactRecordDb()
    .prepare(`SELECT * FROM contact_emails WHERE lead_id = ? ORDER BY is_primary DESC, created_at ASC`)
    .all(leadId) as EmailRow[]).map(toEmail);
}

export function addEmail(leadId: string, address: string, kind: unknown, makePrimary: boolean): ContactEmail {
  const d = getContactRecordDb();
  const id = randomUUID();
  const existing = listEmails(leadId);
  // First one on the record is the primary whether or not anybody asked.
  const primary = makePrimary || existing.length === 0;
  if (primary) d.prepare(`UPDATE contact_emails SET is_primary = 0 WHERE lead_id = ?`).run(leadId);
  d.prepare(
    `INSERT INTO contact_emails (id, lead_id, address, kind, is_primary, created_at) VALUES (?,?,?,?,?,?)`,
  ).run(id, leadId, address.trim(), normEmailKind(kind), bool(primary), nowIso());
  return getEmail(id)!;
}

export function getEmail(id: string): ContactEmail | null {
  const r = getContactRecordDb().prepare(`SELECT * FROM contact_emails WHERE id = ?`).get(id) as EmailRow | undefined;
  return r ? toEmail(r) : null;
}

export function updateEmail(
  id: string,
  patch: { address?: string; kind?: unknown; isPrimary?: boolean },
): ContactEmail | null {
  const cur = getEmail(id);
  if (!cur) return null;
  const d = getContactRecordDb();
  if (patch.isPrimary) d.prepare(`UPDATE contact_emails SET is_primary = 0 WHERE lead_id = ?`).run(cur.leadId);
  d.prepare(`UPDATE contact_emails SET address = ?, kind = ?, is_primary = ? WHERE id = ?`).run(
    patch.address !== undefined ? patch.address.trim() : cur.address,
    patch.kind !== undefined ? normEmailKind(patch.kind) : cur.kind,
    bool(patch.isPrimary !== undefined ? patch.isPrimary : cur.isPrimary),
    id,
  );
  return getEmail(id);
}

export function deleteEmail(id: string): ContactEmail | null {
  const cur = getEmail(id);
  if (!cur) return null;
  const d = getContactRecordDb();
  d.prepare(`DELETE FROM contact_emails WHERE id = ?`).run(id);
  // Never leave a record with rows but no primary — promote the oldest.
  if (cur.isPrimary) {
    const next = listEmails(cur.leadId)[0];
    if (next) d.prepare(`UPDATE contact_emails SET is_primary = 1 WHERE id = ?`).run(next.id);
  }
  return cur;
}

/* ────────────────────────── phones ────────────────────────── */

type PhoneRow = {
  id: string; lead_id: string; number: string; kind: string; dnc: number; is_primary: number; created_at: string;
};
const toPhone = (r: PhoneRow): ContactPhone => ({
  id: r.id, leadId: r.lead_id, number: r.number, kind: normPhoneKind(r.kind),
  dnc: !!r.dnc, isPrimary: !!r.is_primary, createdAt: r.created_at,
});

export function listPhones(leadId: string): ContactPhone[] {
  return (getContactRecordDb()
    .prepare(`SELECT * FROM contact_phones WHERE lead_id = ? ORDER BY is_primary DESC, created_at ASC`)
    .all(leadId) as PhoneRow[]).map(toPhone);
}

export function getPhone(id: string): ContactPhone | null {
  const r = getContactRecordDb().prepare(`SELECT * FROM contact_phones WHERE id = ?`).get(id) as PhoneRow | undefined;
  return r ? toPhone(r) : null;
}

export function addPhone(
  leadId: string,
  number: string,
  kind: unknown,
  dnc: boolean,
  makePrimary: boolean,
): ContactPhone {
  const d = getContactRecordDb();
  const id = randomUUID();
  const primary = makePrimary || listPhones(leadId).length === 0;
  if (primary) d.prepare(`UPDATE contact_phones SET is_primary = 0 WHERE lead_id = ?`).run(leadId);
  d.prepare(
    `INSERT INTO contact_phones (id, lead_id, number, kind, dnc, is_primary, created_at) VALUES (?,?,?,?,?,?,?)`,
  ).run(id, leadId, formatUsPhone(number), normPhoneKind(kind), bool(dnc), bool(primary), nowIso());
  return getPhone(id)!;
}

export function updatePhone(
  id: string,
  patch: { number?: string; kind?: unknown; dnc?: boolean; isPrimary?: boolean },
): ContactPhone | null {
  const cur = getPhone(id);
  if (!cur) return null;
  const d = getContactRecordDb();
  if (patch.isPrimary) d.prepare(`UPDATE contact_phones SET is_primary = 0 WHERE lead_id = ?`).run(cur.leadId);
  d.prepare(`UPDATE contact_phones SET number = ?, kind = ?, dnc = ?, is_primary = ? WHERE id = ?`).run(
    patch.number !== undefined ? formatUsPhone(patch.number) : cur.number,
    patch.kind !== undefined ? normPhoneKind(patch.kind) : cur.kind,
    bool(patch.dnc !== undefined ? patch.dnc : cur.dnc),
    bool(patch.isPrimary !== undefined ? patch.isPrimary : cur.isPrimary),
    id,
  );
  return getPhone(id);
}

export function deletePhone(id: string): ContactPhone | null {
  const cur = getPhone(id);
  if (!cur) return null;
  const d = getContactRecordDb();
  d.prepare(`DELETE FROM contact_phones WHERE id = ?`).run(id);
  if (cur.isPrimary) {
    const next = listPhones(cur.leadId)[0];
    if (next) d.prepare(`UPDATE contact_phones SET is_primary = 1 WHERE id = ?`).run(next.id);
  }
  return cur;
}

/* ────────────────────────── addresses ────────────────────────── */

type AddressRow = {
  id: string; lead_id: string; kind: string; street: string; apt: string; city: string;
  region: string; country: string; postal_code: string; created_at: string;
};
const toAddress = (r: AddressRow): ContactAddress => ({
  id: r.id, leadId: r.lead_id, kind: normAddressKind(r.kind), street: r.street, apt: r.apt,
  city: r.city, region: r.region, country: r.country, postalCode: r.postal_code, createdAt: r.created_at,
});

export function listAddresses(leadId: string): ContactAddress[] {
  return (getContactRecordDb()
    .prepare(`SELECT * FROM contact_addresses WHERE lead_id = ? ORDER BY created_at ASC`)
    .all(leadId) as AddressRow[]).map(toAddress);
}

export function getAddress(id: string): ContactAddress | null {
  const r = getContactRecordDb().prepare(`SELECT * FROM contact_addresses WHERE id = ?`).get(id) as
    | AddressRow
    | undefined;
  return r ? toAddress(r) : null;
}

export interface AddressInput {
  kind?: unknown;
  street?: string;
  apt?: string;
  city?: string;
  region?: string;
  country?: string;
  postalCode?: string;
}

export function addAddress(leadId: string, input: AddressInput): ContactAddress {
  const id = randomUUID();
  const country = (input.country || "US").trim().toUpperCase().slice(0, 2) || "US";
  getContactRecordDb()
    .prepare(
      `INSERT INTO contact_addresses (id, lead_id, kind, street, apt, city, region, country, postal_code, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id, leadId, normAddressKind(input.kind), (input.street || "").trim(), (input.apt || "").trim(),
      (input.city || "").trim(), (input.region || "").trim().toUpperCase(), country,
      (input.postalCode || "").trim(), nowIso(),
    );
  return getAddress(id)!;
}

export function updateAddress(id: string, input: AddressInput): ContactAddress | null {
  const cur = getAddress(id);
  if (!cur) return null;
  const pick = <T>(v: T | undefined, fallback: T): T => (v === undefined ? fallback : v);
  getContactRecordDb()
    .prepare(
      `UPDATE contact_addresses SET kind=?, street=?, apt=?, city=?, region=?, country=?, postal_code=? WHERE id=?`,
    )
    .run(
      input.kind !== undefined ? normAddressKind(input.kind) : cur.kind,
      pick(input.street, cur.street).trim(),
      pick(input.apt, cur.apt).trim(),
      pick(input.city, cur.city).trim(),
      pick(input.region, cur.region).trim().toUpperCase(),
      pick(input.country, cur.country).trim().toUpperCase().slice(0, 2) || "US",
      pick(input.postalCode, cur.postalCode).trim(),
      id,
    );
  return getAddress(id);
}

export function deleteAddress(id: string): boolean {
  return getContactRecordDb().prepare(`DELETE FROM contact_addresses WHERE id = ?`).run(id).changes > 0;
}

/** One line, the way an envelope reads. Used to seed the Lead's `address`. */
export function addressOneLine(a: ContactAddress): string {
  const street = [a.street, a.apt].filter(Boolean).join(" #");
  const tail = [a.city, [a.region, a.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [street, tail, a.country && a.country !== "US" ? a.country : ""].filter(Boolean).join(", ");
}

/* ────────────────────────── social ────────────────────────── */

type SocialRow = { lead_id: string; platform: string; url: string; updated_at: string };

export function listSocial(leadId: string): ContactSocialLink[] {
  const rows = getContactRecordDb()
    .prepare(`SELECT * FROM contact_social_links WHERE lead_id = ?`)
    .all(leadId) as SocialRow[];
  const byPlatform = new Map(rows.map((r) => [r.platform, r]));
  // Ordered by SOCIAL_PLATFORMS so the block's icon row never reshuffles.
  return SOCIAL_PLATFORMS.filter((p) => byPlatform.has(p)).map((p) => {
    const r = byPlatform.get(p)!;
    return { leadId, platform: p, url: r.url, updatedAt: r.updated_at };
  });
}

/**
 * Replace the whole set from the Edit Modal. A blank URL removes the link
 * rather than storing an empty string, so "has a Facebook" stays a real yes/no.
 */
export function setSocial(leadId: string, links: Record<string, unknown>): ContactSocialLink[] {
  const d = getContactRecordDb();
  const at = nowIso();
  const del = d.prepare(`DELETE FROM contact_social_links WHERE lead_id = ? AND platform = ?`);
  const put = d.prepare(
    `INSERT INTO contact_social_links (lead_id, platform, url, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(lead_id, platform) DO UPDATE SET url = excluded.url, updated_at = excluded.updated_at`,
  );
  d.transaction(() => {
    for (const platform of SOCIAL_PLATFORMS) {
      if (!(platform in links)) continue;
      const raw = links[platform];
      const url = typeof raw === "string" ? normalizeSocialUrl(platform, raw) : "";
      if (!url) del.run(leadId, platform);
      else put.run(leadId, platform, url, at);
    }
  })();
  return listSocial(leadId);
}

const SOCIAL_HOSTS: Record<SocialPlatform, string> = {
  facebook: "https://facebook.com/",
  x: "https://x.com/",
  linkedin: "https://linkedin.com/in/",
  instagram: "https://instagram.com/",
  youtube: "https://youtube.com/@",
  tiktok: "https://tiktok.com/@",
  pinterest: "https://pinterest.com/",
};

/**
 * The "auto-formatting" the spec's tip describes: a bare handle becomes the
 * platform's profile URL, a full URL is kept as typed. Only http(s) survives —
 * a `javascript:` "profile" would otherwise become a live link in the block.
 */
export function normalizeSocialUrl(platform: SocialPlatform, raw: string): string {
  const v = (raw || "").trim();
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v.slice(0, 400);
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return ""; // any other scheme: refuse
  const handle = v.replace(/^@+/, "").replace(/^\/+/, "");
  if (!handle) return "";
  return (SOCIAL_HOSTS[platform] + handle).slice(0, 400);
}

/* ────────────────────────── notes ────────────────────────── */

type NoteRow = {
  id: string; lead_id: string; body: string; hidden_from_viewers: number;
  important: number; author: string; created_at: string;
};

export function listNotes(leadId: string): ContactNote[] {
  const d = getContactRecordDb();
  const rows = d
    .prepare(`SELECT * FROM contact_notes WHERE lead_id = ? ORDER BY created_at DESC`)
    .all(leadId) as NoteRow[];
  if (!rows.length) return [];
  const mentions = d
    .prepare(`SELECT note_id, member_id, member_name FROM note_mentions WHERE lead_id = ?`)
    .all(leadId) as Array<{ note_id: string; member_id: string; member_name: string }>;
  const byNote = new Map<string, NoteMention[]>();
  for (const m of mentions) {
    const list = byNote.get(m.note_id) || [];
    list.push({ memberId: m.member_id, memberName: m.member_name });
    byNote.set(m.note_id, list);
  }
  return rows.map((r) => ({
    id: r.id,
    leadId: r.lead_id,
    body: r.body,
    hiddenFromViewers: !!r.hidden_from_viewers,
    important: !!r.important,
    author: r.author,
    mentions: byNote.get(r.id) || [],
    createdAt: r.created_at,
  }));
}

export interface NoteInput {
  body: string;
  hiddenFromViewers?: boolean;
  important?: boolean;
  author?: string;
  mentions?: NoteMention[];
}

export function addNote(leadId: string, input: NoteInput): ContactNote {
  const d = getContactRecordDb();
  const id = randomUUID();
  const at = nowIso();
  d.transaction(() => {
    d.prepare(
      `INSERT INTO contact_notes (id, lead_id, body, hidden_from_viewers, important, author, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(
      id, leadId, input.body.trim().slice(0, 8000),
      // Default hidden: the modal's toggle starts on, and a note written for
      // the team must never leak to a client view because nobody touched it.
      bool(input.hiddenFromViewers === undefined ? true : input.hiddenFromViewers),
      bool(input.important), (input.author || "").slice(0, 120), at,
    );
    const put = d.prepare(
      `INSERT INTO note_mentions (id, note_id, lead_id, member_id, member_name, created_at) VALUES (?,?,?,?,?,?)`,
    );
    for (const m of (input.mentions || []).slice(0, 20)) {
      if (!m || !m.memberId) continue;
      put.run(randomUUID(), id, leadId, String(m.memberId).slice(0, 80), String(m.memberName || "").slice(0, 120), at);
    }
  })();
  return listNotes(leadId).find((n) => n.id === id)!;
}

export function updateNote(
  id: string,
  patch: { body?: string; hiddenFromViewers?: boolean; important?: boolean },
): ContactNote | null {
  const d = getContactRecordDb();
  const cur = d.prepare(`SELECT * FROM contact_notes WHERE id = ?`).get(id) as NoteRow | undefined;
  if (!cur) return null;
  d.prepare(`UPDATE contact_notes SET body = ?, hidden_from_viewers = ?, important = ? WHERE id = ?`).run(
    patch.body !== undefined ? patch.body.trim().slice(0, 8000) : cur.body,
    bool(patch.hiddenFromViewers !== undefined ? patch.hiddenFromViewers : !!cur.hidden_from_viewers),
    bool(patch.important !== undefined ? patch.important : !!cur.important),
    id,
  );
  return listNotes(cur.lead_id).find((n) => n.id === id) || null;
}

export function deleteNote(id: string): boolean {
  const d = getContactRecordDb();
  return d.transaction(() => {
    d.prepare(`DELETE FROM note_mentions WHERE note_id = ?`).run(id);
    return d.prepare(`DELETE FROM contact_notes WHERE id = ?`).run(id).changes > 0;
  })();
}

/* ────────────────────────── documents ────────────────────────── */

/** Document types the Select Document Type modal offers. */
export const CONTACT_DOC_TYPES = [
  { id: "buyer_representation", label: "Buyer Representation Agreement" },
  { id: "listing_agreement", label: "Listing Agreement" },
  { id: "referral_agreement", label: "Referral Agreement" },
  { id: "disclosure", label: "Disclosure" },
  { id: "pre_approval", label: "Pre-Approval Letter" },
  { id: "identification", label: "Identification" },
  { id: "other", label: "Other" },
] as const;

const DOC_TYPE_IDS = new Set(CONTACT_DOC_TYPES.map((t) => t.id as string));
export function normDocType(v: unknown): string {
  return typeof v === "string" && DOC_TYPE_IDS.has(v) ? v : "other";
}

type DocRow = {
  id: string; lead_id: string; doc_type: string; file_name: string; mime: string; bytes: number;
  stored_path: string; signed_date: string | null; expiration_date: string | null;
  transaction_id: string | null; created_at: string;
};
const toDoc = (r: DocRow): ContactDocument => ({
  id: r.id, leadId: r.lead_id, docType: r.doc_type, fileName: r.file_name, mime: r.mime,
  bytes: r.bytes, storedPath: r.stored_path, signedDate: r.signed_date,
  expirationDate: r.expiration_date, transactionId: r.transaction_id, createdAt: r.created_at,
});

export function listDocuments(leadId: string): ContactDocument[] {
  return (getContactRecordDb()
    .prepare(`SELECT * FROM contact_documents WHERE lead_id = ? ORDER BY created_at DESC`)
    .all(leadId) as DocRow[]).map(toDoc);
}

export function getDocument(id: string): ContactDocument | null {
  const r = getContactRecordDb().prepare(`SELECT * FROM contact_documents WHERE id = ?`).get(id) as
    | DocRow
    | undefined;
  return r ? toDoc(r) : null;
}

export interface DocumentInput {
  docType: unknown;
  fileName: string;
  mime: string;
  bytes: number;
  storedPath: string;
  signedDate?: unknown;
  expirationDate?: unknown;
  transactionId?: string | null;
}

export function addDocument(leadId: string, input: DocumentInput): ContactDocument {
  const id = randomUUID();
  getContactRecordDb()
    .prepare(
      `INSERT INTO contact_documents
       (id, lead_id, doc_type, file_name, mime, bytes, stored_path, signed_date, expiration_date, transaction_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id, leadId, normDocType(input.docType), input.fileName.slice(0, 260), input.mime.slice(0, 120),
      Math.max(0, Math.round(input.bytes)), input.storedPath, normDay(input.signedDate),
      normDay(input.expirationDate), input.transactionId || null, nowIso(),
    );
  return getDocument(id)!;
}

export function deleteDocument(id: string): ContactDocument | null {
  const cur = getDocument(id);
  if (!cur) return null;
  getContactRecordDb().prepare(`DELETE FROM contact_documents WHERE id = ?`).run(id);
  // The row is the only thing pointing at the file, so the file goes with it.
  try {
    if (cur.storedPath && existsSync(cur.storedPath)) rmSync(cur.storedPath);
  } catch (err) {
    console.error("[contactRecord] could not remove document file:", err);
  }
  return cur;
}

/* ────────────────────────── whole record ────────────────────────── */

export function getContactRecord(leadId: string): ContactRecord {
  return {
    emails: listEmails(leadId),
    phones: listPhones(leadId),
    addresses: listAddresses(leadId),
    social: listSocial(leadId),
    notes: listNotes(leadId),
    documents: listDocuments(leadId),
  };
}

/**
 * Seed the multi-value tables from the Lead's single-value fields, once.
 *
 * Every contact in this CRM predates this store, so without this the record
 * would open blank for 1,300 people who plainly do have an email and a phone.
 * It runs only when the lead has NO rows of that kind yet, so it can never
 * duplicate a row a human added or resurrect one they deleted.
 */
export function seedFromLead(lead: {
  id: string;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
}): void {
  if (!lead || !lead.id) return;
  const d = getContactRecordDb();
  const countOf = (table: string): number =>
    (d.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE lead_id = ?`).get(lead.id) as { n: number }).n;
  if (lead.email && lead.email.trim() && countOf("contact_emails") === 0) {
    addEmail(lead.id, lead.email, "personal", true);
  }
  if (lead.phone && lead.phone.trim() && countOf("contact_phones") === 0) {
    addPhone(lead.id, lead.phone, "mobile", false, true);
  }
  if (lead.address && lead.address.trim() && countOf("contact_addresses") === 0) {
    // A free-text address cannot be split reliably, so it goes in as the street
    // line and the operator can correct it — better than three empty fields.
    addAddress(lead.id, { kind: "home", street: lead.address.trim(), country: "US" });
  }
}
