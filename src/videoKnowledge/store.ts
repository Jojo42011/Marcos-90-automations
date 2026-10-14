import { referenceId } from "./references.js";
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {assessApproval, corroboratedFacts} from "./approval.js";
import {describeVideo, matchDescriptions} from "./search.js";
export const FIELDS = ["city", "area", "address", "price", "bedrooms", "bathrooms", "size", "acreage", "builder", "features"] as const;
export type Field = typeof FIELDS[number];
export interface Fact {
    field: Field;
    value: string;
    quote: string;
    source: "caption" | "transcript";
}
export interface Conflict { field: Field; question: string; candidates: Fact[]; }
export interface Resolution { field: Field; candidate: number | null; reason: string; }
export interface Notes {
    evidence?: Fact[];
    conflicts?: Conflict[];
    warnings?: string[];
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
    conflicts: string;
    decisions: string;
    warnings: string;
    approval: string;
    description: string;
    summary: string;
    revision: string;
    source_hash: string;
    attempts: number;
    next_attempt: number;
    lease: string | null;
}
const normalize = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export function validateNotes(value: unknown, video: Pick<Video, "caption" | "transcript">): Notes {
    const n = value as Notes;
    if (!n || !Array.isArray(n.facts) || !Array.isArray(n.keywords) || n.facts.length > 24 || n.keywords.length > 8)
        throw new Error("Invalid property notes");
    const used = new Set<string>();
    for (const f of n.facts) {
        if (!FIELDS.includes(f.field) || (used.has(f.field) && f.field !== 'features') || !["caption", "transcript"].includes(f.source))
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
    if(n.warnings!==undefined && (!Array.isArray(n.warnings)||n.warnings.length>40||n.warnings.some(w=>typeof w!=='string'||w.length>500)))throw Error('Invalid review warnings');
    if (n.evidence !== undefined) {
        if (!Array.isArray(n.evidence) || n.evidence.length > 128) throw Error('Invalid source evidence');
        for (const fact of n.evidence) validateNotes({facts:[fact],keywords:[]},video);
    }
    if (n.conflicts !== undefined) {
        if (!Array.isArray(n.conflicts) || n.conflicts.length > FIELDS.length) throw Error('Invalid review conflicts');
        const fields = new Set<string>();
        for (const c of n.conflicts) {
            if (!c || !FIELDS.includes(c.field) || fields.has(c.field) || typeof c.question !== 'string' || c.question.length > 500 || !Array.isArray(c.candidates) || c.candidates.length < 2 || c.candidates.length > 8) throw Error('Invalid review conflict');
            fields.add(c.field);
            for (const fact of c.candidates) { if (fact.field !== c.field) throw Error('Conflict field mismatch'); validateNotes({facts:[fact],keywords:[]},video); }
            if (n.facts.some(f=>f.field===c.field)) throw Error('Conflicting facts must be held for review');
        }
    }
    return { ...(n.evidence!==undefined?{evidence:n.evidence}:{}), ...(n.warnings!==undefined?{warnings:n.warnings}:{}), ...(n.conflicts !== undefined ? {conflicts:n.conflicts} : {}), facts: n.facts.map(f => ({ field: f.field, value: f.value.trim(), quote: f.quote, source: f.source })), keywords: [...new Set(n.keywords.map(normalize))] };
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
        this.db.exec("CREATE TABLE IF NOT EXISTS video_lookup (account TEXT, person TEXT, attempts INTEGER, question TEXT, at INTEGER, PRIMARY KEY(account,person))");
        this.migrateReviewColumns();
    }
    private migrateReviewColumns(): void {
        const columns = this.db.prepare('PRAGMA table_info(videos)').all() as {name:string}[];
        for (const name of ['conflicts','decisions','warnings']) if (!columns.some(c=>c.name===name)) this.db.exec(`ALTER TABLE videos ADD COLUMN ${name} TEXT NOT NULL DEFAULT '[]'`);
        if (!columns.some(c=>c.name==='approval')) this.db.exec("ALTER TABLE videos ADD COLUMN approval TEXT NOT NULL DEFAULT '{}'");
        for (const name of ['description','summary']) if (!columns.some(c=>c.name===name)) this.db.exec(`ALTER TABLE videos ADD COLUMN ${name} TEXT NOT NULL DEFAULT ''`);
        const audit = this.db.prepare('PRAGMA table_info(video_audit)').all() as {name:string}[];
        if (!audit.some(c=>c.name==='detail')) this.db.exec("ALTER TABLE video_audit ADD COLUMN detail TEXT");
    }
    summary(account: string): Record<string,number> {
        return Object.fromEntries((this.db.prepare('SELECT state,count(*) count FROM videos WHERE account=? GROUP BY state').all(account) as {state:string;count:number}[]).map(r=>[r.state,r.count]));
    }
    get(account: string, post: string): Video | undefined { return this.db.prepare("SELECT * FROM videos WHERE account=? AND post=?").get(account, post) as Video | undefined; }
    list(account: string, offset = 0): Video[] { return this.db.prepare("SELECT * FROM videos WHERE account=? ORDER BY published DESC,post DESC LIMIT 50 OFFSET ?").all(account, offset) as Video[]; }
    ingest(v: Pick<Video, "account" | "post" | "url" | "caption" | "published">): boolean {
        if (!v.account || !/^\d+$/.test(v.post) || postId(v.url) !== v.post || v.caption.length > 16000 || !Number.isFinite(Date.parse(v.published)))
            throw new Error("Invalid video metadata");
        const canonical = new URL(v.url); canonical.search=''; canonical.hash=''; v={...v,url:canonical.href,published:new Date(v.published).toISOString()};
        const revision = createHash("sha256").update(JSON.stringify([v.url, v.caption, v.published])).digest("hex");
        const old = this.get(v.account, v.post);
        if (old?.source_hash === revision)
            return false;
        this.db.prepare(`INSERT INTO videos(account,post,url,caption,published,revision,source_hash) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(account,post) DO UPDATE SET url=excluded.url,caption=excluded.caption,published=excluded.published,revision=excluded.revision,source_hash=excluded.source_hash,
      state='queued',transcript='',notes='{}',conflicts='[]',decisions='[]',warnings='[]',approval='{}',description='',summary='',attempts=0,next_attempt=0,lease=NULL,error=NULL`).run(v.account, v.post, v.url, v.caption, v.published, randomUUID(), revision);
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
    saveTranscript(v: Video, transcript: string): void {
        if (!transcript.trim() || transcript.length > 60000) throw Error('Transcript missing or too large');
        this.db.prepare("UPDATE videos SET transcript=? WHERE account=? AND post=? AND lease=? AND revision=?").run(transcript,v.account,v.post,v.lease,v.revision);
    }
    complete(v: Video, transcript: string, notes: Notes): void {
        if (!transcript.trim() || transcript.length > 60000) throw Error('Transcript missing or too large');
        const checked = validateNotes(notes, { ...v, transcript });
        const conflicts = checked.conflicts || [];
        const assessment = assessApproval(checked,{...v,transcript});
        const facts = checked.evidence ? corroboratedFacts(checked,{...v,transcript}) : [];
        const approval = {...assessment,mode: facts.length ? (assessment.mode==='automatic'?'automatic':'partial') : 'unavailable'};
        const state = checked.evidence ? (facts.length ? 'ready' : 'unavailable') : conflicts.length || checked.warnings?.length ? 'needs_confirmation' : 'needs_review';
        this.db.transaction(() => {
            const revision = randomUUID();
            const updated = this.db.prepare("UPDATE videos SET state=?,transcript=?,notes=?,conflicts=?,warnings=?,approval=?,description=?,summary=?,decisions='[]',revision=?,lease=NULL,error=NULL WHERE account=? AND post=? AND lease=? AND revision=?")
                .run(state,transcript,JSON.stringify({facts:checked.evidence?facts:checked.facts,keywords:checked.keywords,evidence:checked.evidence}),JSON.stringify(conflicts),JSON.stringify(checked.warnings||[]),JSON.stringify(approval),describeVideo(checked),facts.map(f=>f.value).join('; ').slice(0,600),revision,v.account,v.post,v.lease,v.revision);
            if (updated.changes) this.db.prepare('INSERT INTO video_audit(account,post,revision,action,at,detail) VALUES(?,?,?,?,?,?)')
                .run(v.account,v.post,revision,facts.length?'auto_approve':'details_withheld',Date.now(),JSON.stringify({...approval,evidence:checked.evidence||[]}));
        }).immediate();
    }

    fail(v: Video, stage: 'transcription' | 'fact_extraction' = 'transcription'): void {
        this.db.prepare("UPDATE videos SET state=?,next_attempt=?,error=?,lease=NULL WHERE account=? AND post=? AND lease=? AND revision=?")
            .run(v.attempts >= 3 ? 'failed' : 'queued', Date.now()+v.attempts*300000,
            stage==='transcription' ? 'Transcription failed: check public video access, duration and installed media tools.' : 'Fact extraction failed validation or model access. Transcript retained for retry; no facts approved.',v.account,v.post,v.lease,v.revision);
    }
    review(account: string, post: string, revision: string, action: 'approve' | 'disable' | 'retry', notes?: unknown, resolutions?: Resolution[], acknowledgeWarnings = false): Video {
        return this.db.transaction(() => {
            const v=this.get(account,post);
            if (!v || v.revision!==revision) throw Error('Video changed; reload before reviewing');
            if(action==='approve' && (!['needs_review','needs_confirmation','ready'].includes(v.state)||!v.transcript)) throw Error('Transcript is not ready for approval');
            let checked: Notes | null = null; let decisions: Resolution[] = [];
            if(action==='approve') {
                if(JSON.parse(v.warnings).length && acknowledgeWarnings!==true)throw Error('Review and acknowledge the omitted extraction claims before approval');
                const conflicts=JSON.parse(v.conflicts) as Conflict[];
                const proposed=(notes ?? JSON.parse(v.notes)) as Notes;
                if(!proposed || !Array.isArray(proposed.facts)) throw Error('Invalid property notes');
                if (conflicts.length) {
                    if(!Array.isArray(resolutions)||resolutions.length!==conflicts.length||new Set(resolutions.map(r=>r.field)).size!==conflicts.length) throw Error('Resolve every source disagreement before approval');
                    const chosen: Fact[] = [];
                    for(const conflict of conflicts) {
                        const answer=resolutions.find(r=>r.field===conflict.field);
                        if(!answer||typeof answer.reason!=='string'||answer.reason.trim().length<3||answer.reason.length>500) throw Error('Explain each source disagreement decision');
                        if(answer.candidate!==null) {
                            if(!Number.isInteger(answer.candidate)||answer.candidate<0||answer.candidate>=conflict.candidates.length) throw Error('Choose a displayed source value or omit it');
                            chosen.push(conflict.candidates[answer.candidate]!);
                        }
                        decisions.push({field:conflict.field,candidate:answer.candidate,reason:answer.reason.trim()});
                    }
                    checked=validateNotes({facts:[...proposed.facts.filter(f=>!conflicts.some(c=>c.field===f.field)),...chosen],keywords:proposed.keywords},v);
                } else checked=validateNotes({facts:proposed.facts,keywords:proposed.keywords},v);
                if(!checked.facts.length) throw Error('Approve at least one supported property fact');
            }
            this.db.prepare('UPDATE videos SET state=?,notes=?,decisions=?,approval=?,revision=?,lease=NULL,attempts=0,next_attempt=0 WHERE account=? AND post=?')
                .run(action==='approve'?'ready':action==='disable'?'disabled':'queued',checked?JSON.stringify(checked):v.notes,action==='approve'?JSON.stringify(decisions):v.decisions,action==='approve'?JSON.stringify({...JSON.parse(v.approval),mode:'manual'}):'{}',randomUUID(),account,post);
            this.db.prepare('INSERT INTO video_audit(account,post,revision,action,at,detail) VALUES(?,?,?,?,?,?)').run(account,post,revision,action,Date.now(),JSON.stringify({decisions,acknowledgedWarnings:acknowledgeWarnings===true}));
            return this.get(account,post)!;
        }).immediate();
    }
    comment(account: string, person: string, post: string, at: number): void {
        if (!person || !/^\d+$/.test(post) || !Number.isFinite(at))
            return;
        this.db.prepare("INSERT INTO video_comments VALUES(?,?,?,?) ON CONFLICT(account,person,post) DO UPDATE SET at=max(at,excluded.at)").run(account, person, post, at);
    }
    lookup(account:string,person:string): {attempts:number;question:string}|undefined {
        return this.db.prepare('SELECT attempts,question FROM video_lookup WHERE account=? AND person=? AND at>?').get(account,person,Date.now()-86400000) as {attempts:number;question:string}|undefined;
    }
    clarify(account:string,person:string,question:string): number {
        const prior=this.lookup(account,person); const attempts=Math.min(3,(prior?.attempts||0)+1);
        this.db.prepare('INSERT INTO video_lookup VALUES(?,?,?,?,?) ON CONFLICT(account,person) DO UPDATE SET attempts=excluded.attempts,question=excluded.question,at=excluded.at').run(account,person,attempts,prior?.question||question,Date.now());
        return attempts;
    }
    clearLookup(account:string,person:string): void { this.db.prepare('DELETE FROM video_lookup WHERE account=? AND person=?').run(account,person); }
    search(account:string,message:string): {post:string;description:string}[] {
        return matchDescriptions(this.db.prepare("SELECT post,description FROM videos WHERE account=? AND state IN ('ready','unavailable')").all(account) as {post:string;description:string}[],message);
    }
    resolve(account: string, person: string, message: string, now = Date.now()): {
        video?: Video;
        reason: string;
    } {
        const links = message.match(/https?:\/\/[^\s<>]+/g) || [];
        const ids = [...new Set(links.map(s => referenceId(s.replace(/[),.!?]+$/, ''))).filter(Boolean))] as string[];
        let candidates: string[] = [], reason = 'none';
        if (links.some(l => /tiktok\.com/i.test(l))) {
            candidates = ids;
            reason = 'link';
        }
        else {
            const rows = this.db.prepare("SELECT post,notes FROM videos WHERE account=? AND state IN ('ready','unavailable','needs_review','needs_confirmation')").all(account) as Pick<Video, 'post' | 'notes'>[];
            const words = ` ${normalize(message)} `;
            candidates = rows.filter(v => (JSON.parse(v.notes) as Notes).keywords.some(k => words.includes(` ${normalize(k)} `))).map(v => v.post);
            if (candidates.length)
                reason = 'keyword';
            else if (this.search(account,message).length) {
                candidates=this.search(account,message).map(v=>v.post);
                reason='description';
            }
            else if (/\b(?:another|different|other|new)\s+(?:house|home|property|video)\b|\b(?:house|home|one|video|place)\s+(?:with|that|which|had)\b/i.test(message))
                reason = 'switch';
            else {
                const context = this.db.prepare("SELECT post FROM video_context WHERE account=? AND person=? AND at>?").get(account, person, now - 7 * 86400000) as {
                    post: string;
                } | undefined;
                if (context && context.post!=='unresolved') {
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
        return video?.state === 'ready' ? { video, reason } : video ? { reason: 'pending' } : {reason:'unknown_link'};
    }
    close(): void { this.db.close(); }
}
