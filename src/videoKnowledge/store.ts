import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
export const FIELDS = ["city", "area", "address", "price", "bedrooms", "bathrooms", "size", "acreage", "builder", "features"] as const;
export type Field = typeof FIELDS[number];
export interface Fact {
    field: Field;
    value: string;
    quote: string;
    source: "caption" | "transcript";
}
export interface Notes {
    facts: Fact[];
    keywords: string[];
}
export interface Video {
    account: string;
    post: string;
    url: string;
    caption: string;
    published: string;
    state: string;
    transcript: string;
    notes: string;
    error: string | null;
    revision: string;
    source_hash: string;
    attempts: number;
    next_attempt: number;
    lease: string | null;
}
const normalize = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export function validateNotes(value: unknown, video: Pick<Video, "caption" | "transcript">): Notes {
    const n = value as Notes;
    if (!n || !Array.isArray(n.facts) || !Array.isArray(n.keywords) || n.facts.length > 12 || n.keywords.length > 8)
        throw new Error("Invalid property notes");
    const used = new Set<string>();
    for (const f of n.facts) {
        if (!FIELDS.includes(f.field) || used.has(f.field) || !["caption", "transcript"].includes(f.source))
            throw new Error("Invalid or conflicting property field");
        used.add(f.field);
        if (typeof f.value !== "string" || !normalize(f.value) || f.value.length > 90 || /[\n\r<>]/.test(f.value) || typeof f.quote !== "string" || !normalize(f.quote) || f.quote.length < 3 || f.quote.length > 500)
            throw new Error("Invalid property evidence");
        // Both the evidence and the proposed value must actually occur in the source.
        if (!normalize(video[f.source]).includes(normalize(f.quote)) || !(` ${normalize(f.quote)} `).includes(` ${normalize(f.value)} `))
            throw new Error("Property value is not supported by its source quote");
    }
    const generic = new Set(["info", "information", "price", "home", "house", "details", "location", "yes", "hello", "hi"]);
    for (const k of n.keywords)
        if (typeof k !== "string" || normalize(k).length < 3 || k.length > 50 || generic.has(normalize(k)))
            throw new Error("Use specific property keywords");
    return { facts: n.facts.map(f => ({ field: f.field, value: f.value.trim(), quote: f.quote, source: f.source })), keywords: [...new Set(n.keywords.map(normalize))] };
}
export function postId(url: string): string | null {
    try {
        const u = new URL(url);
        return u.protocol === "https:" && /^(?:www\.)?tiktok\.com$/.test(u.hostname) && !u.username && !u.password && !u.port ? u.pathname.match(/^\/@[^/]+\/video\/(\d+)\/?$/)?.[1] ?? null : null;
    }
    catch {
        return null;
    }
}
export class VideoStore {
    readonly db: Database.Database;
    constructor(file: string) {
        if (file !== ":memory:")
            mkdirSync(path.dirname(file), { recursive: true });
        this.db = new Database(file);
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("busy_timeout = 5000");
        this.db.exec(`CREATE TABLE IF NOT EXISTS videos (
      account TEXT NOT NULL, post TEXT NOT NULL, url TEXT NOT NULL, caption TEXT NOT NULL, published TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued', transcript TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '{}',
      revision TEXT NOT NULL, source_hash TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0,
      lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0, error TEXT, PRIMARY KEY(account,post));
      CREATE TABLE IF NOT EXISTS video_audit (id INTEGER PRIMARY KEY, account TEXT, post TEXT, revision TEXT, action TEXT, at INTEGER);
      CREATE TABLE IF NOT EXISTS video_context (account TEXT, person TEXT, post TEXT, at INTEGER, PRIMARY KEY(account,person));
      CREATE TABLE IF NOT EXISTS video_comments (account TEXT, person TEXT, post TEXT, at INTEGER, PRIMARY KEY(account,person,post));`);
    }
    get(account: string, post: string): Video | undefined { return this.db.prepare("SELECT * FROM videos WHERE account=? AND post=?").get(account, post) as Video | undefined; }
    list(account: string, offset = 0): Video[] { return this.db.prepare("SELECT * FROM videos WHERE account=? ORDER BY published DESC,post DESC LIMIT 50 OFFSET ?").all(account, offset) as Video[]; }
    ingest(v: Pick<Video, "account" | "post" | "url" | "caption" | "published">): boolean {
        if (!v.account || !/^\d+$/.test(v.post) || postId(v.url) !== v.post || v.caption.length > 16000 || !Number.isFinite(Date.parse(v.published)))
            throw new Error("Invalid video metadata");
        const revision = createHash("sha256").update(JSON.stringify([v.url, v.caption, v.published])).digest("hex");
        const old = this.get(v.account, v.post);
        if (old?.source_hash === revision)
            return false;
        this.db.prepare(`INSERT INTO videos(account,post,url,caption,published,revision,source_hash) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(account,post) DO UPDATE SET url=excluded.url,caption=excluded.caption,published=excluded.published,revision=excluded.revision,source_hash=excluded.source_hash,
      state='queued',transcript='',notes='{}',attempts=0,next_attempt=0,lease=NULL,error=NULL`).run(v.account, v.post, v.url, v.caption, v.published, randomUUID(), revision);
        return true;
    }
    claim(account: string, now = Date.now()): Video | undefined {
        return this.db.transaction(() => {
            this.db.prepare("UPDATE videos SET state='queued',lease=NULL WHERE account=? AND state='processing' AND lease_until<?").run(account, now);
            const v = this.db.prepare("SELECT * FROM videos WHERE account=? AND state='queued' AND next_attempt<=? ORDER BY published DESC LIMIT 1").get(account, now) as Video | undefined;
            if (!v)
                return undefined;
            const lease = randomUUID();
            this.db.prepare("UPDATE videos SET state='processing',lease=?,lease_until=?,attempts=attempts+1 WHERE account=? AND post=?").run(lease, now + 30 * 60000, account, v.post);
            return { ...v, lease, attempts: v.attempts + 1 };
        }).immediate();
    }
    complete(v: Video, transcript: string, notes: Notes): void {
        if (!transcript.trim() || transcript.length > 60000)
            throw new Error("Transcript missing or too large");
        validateNotes(notes, { ...v, transcript });
        this.db.prepare("UPDATE videos SET state='needs_review',transcript=?,notes=?,revision=?,lease=NULL,error=NULL WHERE account=? AND post=? AND lease=? AND revision=?").run(transcript, JSON.stringify(notes), randomUUID(), v.account, v.post, v.lease, v.revision);
    }
    fail(v: Video, stage: 'transcription' | 'fact_extraction' = 'transcription'): void {
        this.db.prepare("UPDATE videos SET state=?,next_attempt=?,error=?,lease=NULL WHERE account=? AND post=? AND lease=? AND revision=?")
            .run(v.attempts >= 3 ? 'failed' : 'queued', Date.now() + v.attempts * 300000, stage === 'transcription' ? 'Transcription failed: check Zernio Tools access, video availability and local media tools.' : 'Fact extraction failed: check model access or review source ambiguity.', v.account, v.post, v.lease, v.revision);
    }
    review(account: string, post: string, revision: string, action: "approve" | "disable" | "retry", notes?: unknown): Video {
        return this.db.transaction(() => {
            const v = this.get(account, post);
            if (!v || v.revision !== revision)
                throw new Error("Video changed; reload before reviewing");
            if (action === 'approve' && (!['needs_review', 'ready'].includes(v.state) || !v.transcript))
                throw new Error("Transcript is not ready for approval");
            const checked = action === 'approve' ? validateNotes(notes ?? JSON.parse(v.notes), v) : null;
            if (checked && !checked.facts.length)
                throw new Error("Approve at least one supported property fact");
            this.db.prepare("UPDATE videos SET state=?,notes=?,revision=?,lease=NULL,attempts=0,next_attempt=0 WHERE account=? AND post=?")
                .run(action === 'approve' ? 'ready' : action === 'disable' ? 'disabled' : 'queued', checked ? JSON.stringify(checked) : v.notes, randomUUID(), account, post);
            this.db.prepare("INSERT INTO video_audit(account,post,revision,action,at) VALUES(?,?,?,?,?)").run(account, post, revision, action, Date.now());
            return this.get(account, post)!;
        }).immediate();
    }
    comment(account: string, person: string, post: string, at: number): void {
        if (!person || !/^\d+$/.test(post) || !Number.isFinite(at))
            return;
        this.db.prepare("INSERT INTO video_comments VALUES(?,?,?,?) ON CONFLICT(account,person,post) DO UPDATE SET at=max(at,excluded.at)").run(account, person, post, at);
    }
    resolve(account: string, person: string, message: string, now = Date.now()): {
        video?: Video;
        reason: string;
    } {
        const links = message.match(/https?:\/\/[^\s<>]+/g) || [];
        const ids = [...new Set(links.map(s => postId(s.replace(/[),.!?]+$/, ''))).filter(Boolean))] as string[];
        let candidates: string[] = [], reason = 'none';
        if (links.some(l => /tiktok\.com/i.test(l))) {
            candidates = ids;
            reason = 'link';
        }
        else {
            const rows = this.db.prepare("SELECT post,notes FROM videos WHERE account=? AND state='ready'").all(account) as Pick<Video, 'post' | 'notes'>[];
            const words = ` ${normalize(message)} `;
            candidates = rows.filter(v => (JSON.parse(v.notes) as Notes).keywords.some(k => words.includes(` ${normalize(k)} `))).map(v => v.post);
            if (candidates.length)
                reason = 'keyword';
            else if (/\b(?:another|different|other|new)\s+(?:house|home|property|video)\b/i.test(message))
                reason = 'switch';
            else {
                const context = this.db.prepare("SELECT post FROM video_context WHERE account=? AND person=? AND at>?").get(account, person, now - 7 * 86400000) as {
                    post: string;
                } | undefined;
                if (context) {
                    candidates = [context.post];
                    reason = 'conversation';
                }
                else {
                    candidates = (this.db.prepare("SELECT post FROM video_comments WHERE account=? AND person=? AND at>?").all(account, person, now - 7 * 86400000) as {
                        post: string;
                    }[]).map(x => x.post);
                    if (candidates.length)
                        reason = 'comment';
                }
            }
        }
        if (candidates.length !== 1) {
            if (reason !== 'none')
                this.db.prepare("INSERT INTO video_context VALUES(?,?,?,?) ON CONFLICT(account,person) DO UPDATE SET post=excluded.post,at=excluded.at").run(account, person, 'unresolved', now);
            return { reason: candidates.length > 1 ? 'ambiguous' : reason === 'none' ? 'none' : 'unknown' };
        }
        const video = this.get(account, candidates[0]!);
        // Unknown explicit references never fall back to a previously discussed home.
        this.db.prepare("INSERT INTO video_context VALUES(?,?,?,?) ON CONFLICT(account,person) DO UPDATE SET post=excluded.post,at=excluded.at").run(account, person, candidates[0], now);
        return video?.state === 'ready' ? { video, reason } : { reason: 'pending' };
    }
    close(): void { this.db.close(); }
}
