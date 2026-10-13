"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.VideoStore = exports.FIELDS = void 0;
exports.validateNotes = validateNotes;
exports.postId = postId;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const approval_js_1 = require("./approval.js");
exports.FIELDS = ["city", "area", "address", "price", "bedrooms", "bathrooms", "size", "acreage", "builder", "features"];
const normalize = (s) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
function validateNotes(value, video) {
    const n = value;
    if (!n || !Array.isArray(n.facts) || !Array.isArray(n.keywords) || n.facts.length > 12 || n.keywords.length > 8)
        throw new Error("Invalid property notes");
    const used = new Set();
    for (const f of n.facts) {
        if (!exports.FIELDS.includes(f.field) || used.has(f.field) || !["caption", "transcript"].includes(f.source))
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
    if (n.warnings !== undefined && (!Array.isArray(n.warnings) || n.warnings.length > 40 || n.warnings.some(w => typeof w !== 'string' || w.length > 500)))
        throw Error('Invalid review warnings');
    if (n.evidence !== undefined) {
        if (!Array.isArray(n.evidence) || n.evidence.length > 128)
            throw Error('Invalid source evidence');
        for (const fact of n.evidence)
            validateNotes({ facts: [fact], keywords: [] }, video);
    }
    if (n.conflicts !== undefined) {
        if (!Array.isArray(n.conflicts) || n.conflicts.length > exports.FIELDS.length)
            throw Error('Invalid review conflicts');
        const fields = new Set();
        for (const c of n.conflicts) {
            if (!c || !exports.FIELDS.includes(c.field) || fields.has(c.field) || typeof c.question !== 'string' || c.question.length > 500 || !Array.isArray(c.candidates) || c.candidates.length < 2 || c.candidates.length > 8)
                throw Error('Invalid review conflict');
            fields.add(c.field);
            for (const fact of c.candidates) {
                if (fact.field !== c.field)
                    throw Error('Conflict field mismatch');
                validateNotes({ facts: [fact], keywords: [] }, video);
            }
            if (n.facts.some(f => f.field === c.field))
                throw Error('Conflicting facts must be held for review');
        }
    }
    return { ...(n.evidence !== undefined ? { evidence: n.evidence } : {}), ...(n.warnings !== undefined ? { warnings: n.warnings } : {}), ...(n.conflicts !== undefined ? { conflicts: n.conflicts } : {}), facts: n.facts.map(f => ({ field: f.field, value: f.value.trim(), quote: f.quote, source: f.source })), keywords: [...new Set(n.keywords.map(normalize))] };
}
function postId(url) {
    try {
        const u = new URL(url);
        return u.protocol === "https:" && /^(?:www\.)?tiktok\.com$/.test(u.hostname) && !u.username && !u.password && !u.port ? u.pathname.match(/^\/@[^/]+\/video\/(\d+)\/?$/)?.[1] ?? null : null;
    }
    catch {
        return null;
    }
}
class VideoStore {
    db;
    constructor(file) {
        if (file !== ":memory:")
            (0, node_fs_1.mkdirSync)(node_path_1.default.dirname(file), { recursive: true });
        this.db = new better_sqlite3_1.default(file);
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
        this.migrateReviewColumns();
    }
    migrateReviewColumns() {
        const columns = this.db.prepare('PRAGMA table_info(videos)').all();
        for (const name of ['conflicts', 'decisions', 'warnings'])
            if (!columns.some(c => c.name === name))
                this.db.exec(`ALTER TABLE videos ADD COLUMN ${name} TEXT NOT NULL DEFAULT '[]'`);
        if (!columns.some(c => c.name === 'approval'))
            this.db.exec("ALTER TABLE videos ADD COLUMN approval TEXT NOT NULL DEFAULT '{}'");
        const audit = this.db.prepare('PRAGMA table_info(video_audit)').all();
        if (!audit.some(c => c.name === 'detail'))
            this.db.exec("ALTER TABLE video_audit ADD COLUMN detail TEXT");
    }
    summary(account) {
        return Object.fromEntries(this.db.prepare('SELECT state,count(*) count FROM videos WHERE account=? GROUP BY state').all(account).map(r => [r.state, r.count]));
    }
    get(account, post) { return this.db.prepare("SELECT * FROM videos WHERE account=? AND post=?").get(account, post); }
    list(account, offset = 0) { return this.db.prepare("SELECT * FROM videos WHERE account=? ORDER BY published DESC,post DESC LIMIT 50 OFFSET ?").all(account, offset); }
    ingest(v) {
        if (!v.account || !/^\d+$/.test(v.post) || postId(v.url) !== v.post || v.caption.length > 16000 || !Number.isFinite(Date.parse(v.published)))
            throw new Error("Invalid video metadata");
        const canonical = new URL(v.url);
        canonical.search = '';
        canonical.hash = '';
        v = { ...v, url: canonical.href, published: new Date(v.published).toISOString() };
        const revision = (0, node_crypto_1.createHash)("sha256").update(JSON.stringify([v.url, v.caption, v.published])).digest("hex");
        const old = this.get(v.account, v.post);
        if (old?.source_hash === revision)
            return false;
        this.db.prepare(`INSERT INTO videos(account,post,url,caption,published,revision,source_hash) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(account,post) DO UPDATE SET url=excluded.url,caption=excluded.caption,published=excluded.published,revision=excluded.revision,source_hash=excluded.source_hash,
      state='queued',transcript='',notes='{}',conflicts='[]',decisions='[]',warnings='[]',approval='{}',attempts=0,next_attempt=0,lease=NULL,error=NULL`).run(v.account, v.post, v.url, v.caption, v.published, (0, node_crypto_1.randomUUID)(), revision);
        return true;
    }
    claim(account, now = Date.now()) {
        return this.db.transaction(() => {
            this.db.prepare("UPDATE videos SET state='queued',lease=NULL WHERE account=? AND state='processing' AND lease_until<?").run(account, now);
            const v = this.db.prepare("SELECT * FROM videos WHERE account=? AND state='queued' AND next_attempt<=? ORDER BY published DESC LIMIT 1").get(account, now);
            if (!v)
                return undefined;
            const lease = (0, node_crypto_1.randomUUID)();
            this.db.prepare("UPDATE videos SET state='processing',lease=?,lease_until=?,attempts=attempts+1 WHERE account=? AND post=?").run(lease, now + 30 * 60000, account, v.post);
            return { ...v, lease, attempts: v.attempts + 1 };
        }).immediate();
    }
    saveTranscript(v, transcript) {
        if (!transcript.trim() || transcript.length > 60000)
            throw Error('Transcript missing or too large');
        this.db.prepare("UPDATE videos SET transcript=? WHERE account=? AND post=? AND lease=? AND revision=?").run(transcript, v.account, v.post, v.lease, v.revision);
    }
    complete(v, transcript, notes) {
        if (!transcript.trim() || transcript.length > 60000)
            throw Error('Transcript missing or too large');
        const checked = validateNotes(notes, { ...v, transcript });
        const conflicts = checked.conflicts || [];
        const approval = (0, approval_js_1.assessApproval)(checked, { ...v, transcript });
        const state = approval.mode === 'automatic' ? 'ready' : conflicts.length || checked.warnings?.length || checked.evidence ? 'needs_confirmation' : 'needs_review';
        this.db.transaction(() => {
            const revision = (0, node_crypto_1.randomUUID)();
            const updated = this.db.prepare("UPDATE videos SET state=?,transcript=?,notes=?,conflicts=?,warnings=?,approval=?,decisions='[]',revision=?,lease=NULL,error=NULL WHERE account=? AND post=? AND lease=? AND revision=?")
                .run(state, transcript, JSON.stringify({ facts: checked.facts, keywords: checked.keywords, evidence: checked.evidence }), JSON.stringify(conflicts), JSON.stringify(checked.warnings || []), JSON.stringify(approval), revision, v.account, v.post, v.lease, v.revision);
            if (updated.changes)
                this.db.prepare('INSERT INTO video_audit(account,post,revision,action,at,detail) VALUES(?,?,?,?,?,?)')
                    .run(v.account, v.post, revision, approval.mode === 'automatic' ? 'auto_approve' : 'review_required', Date.now(), JSON.stringify({ ...approval, evidence: checked.evidence || [] }));
        }).immediate();
    }
    fail(v, stage = 'transcription') {
        this.db.prepare("UPDATE videos SET state=?,next_attempt=?,error=?,lease=NULL WHERE account=? AND post=? AND lease=? AND revision=?")
            .run(v.attempts >= 3 ? 'failed' : 'queued', Date.now() + v.attempts * 300000, stage === 'transcription' ? 'Transcription failed: check public video access, duration and installed media tools.' : 'Fact extraction failed validation or model access. Transcript retained for retry; no facts approved.', v.account, v.post, v.lease, v.revision);
    }
    review(account, post, revision, action, notes, resolutions, acknowledgeWarnings = false) {
        return this.db.transaction(() => {
            const v = this.get(account, post);
            if (!v || v.revision !== revision)
                throw Error('Video changed; reload before reviewing');
            if (action === 'approve' && (!['needs_review', 'needs_confirmation', 'ready'].includes(v.state) || !v.transcript))
                throw Error('Transcript is not ready for approval');
            let checked = null;
            let decisions = [];
            if (action === 'approve') {
                if (JSON.parse(v.warnings).length && acknowledgeWarnings !== true)
                    throw Error('Review and acknowledge the omitted extraction claims before approval');
                const conflicts = JSON.parse(v.conflicts);
                const proposed = (notes ?? JSON.parse(v.notes));
                if (!proposed || !Array.isArray(proposed.facts))
                    throw Error('Invalid property notes');
                if (conflicts.length) {
                    if (!Array.isArray(resolutions) || resolutions.length !== conflicts.length || new Set(resolutions.map(r => r.field)).size !== conflicts.length)
                        throw Error('Resolve every source disagreement before approval');
                    const chosen = [];
                    for (const conflict of conflicts) {
                        const answer = resolutions.find(r => r.field === conflict.field);
                        if (!answer || typeof answer.reason !== 'string' || answer.reason.trim().length < 3 || answer.reason.length > 500)
                            throw Error('Explain each source disagreement decision');
                        if (answer.candidate !== null) {
                            if (!Number.isInteger(answer.candidate) || answer.candidate < 0 || answer.candidate >= conflict.candidates.length)
                                throw Error('Choose a displayed source value or omit it');
                            chosen.push(conflict.candidates[answer.candidate]);
                        }
                        decisions.push({ field: conflict.field, candidate: answer.candidate, reason: answer.reason.trim() });
                    }
                    checked = validateNotes({ facts: [...proposed.facts.filter(f => !conflicts.some(c => c.field === f.field)), ...chosen], keywords: proposed.keywords }, v);
                }
                else
                    checked = validateNotes({ facts: proposed.facts, keywords: proposed.keywords }, v);
                if (!checked.facts.length)
                    throw Error('Approve at least one supported property fact');
            }
            this.db.prepare('UPDATE videos SET state=?,notes=?,decisions=?,approval=?,revision=?,lease=NULL,attempts=0,next_attempt=0 WHERE account=? AND post=?')
                .run(action === 'approve' ? 'ready' : action === 'disable' ? 'disabled' : 'queued', checked ? JSON.stringify(checked) : v.notes, action === 'approve' ? JSON.stringify(decisions) : v.decisions, action === 'approve' ? JSON.stringify({ ...JSON.parse(v.approval), mode: 'manual' }) : '{}', (0, node_crypto_1.randomUUID)(), account, post);
            this.db.prepare('INSERT INTO video_audit(account,post,revision,action,at,detail) VALUES(?,?,?,?,?,?)').run(account, post, revision, action, Date.now(), JSON.stringify({ decisions, acknowledgedWarnings: acknowledgeWarnings === true }));
            return this.get(account, post);
        }).immediate();
    }
    comment(account, person, post, at) {
        if (!person || !/^\d+$/.test(post) || !Number.isFinite(at))
            return;
        this.db.prepare("INSERT INTO video_comments VALUES(?,?,?,?) ON CONFLICT(account,person,post) DO UPDATE SET at=max(at,excluded.at)").run(account, person, post, at);
    }
    resolve(account, person, message, now = Date.now()) {
        const links = message.match(/https?:\/\/[^\s<>]+/g) || [];
        const ids = [...new Set(links.map(s => postId(s.replace(/[),.!?]+$/, ''))).filter(Boolean))];
        let candidates = [], reason = 'none';
        if (links.some(l => /tiktok\.com/i.test(l))) {
            candidates = ids;
            reason = 'link';
        }
        else {
            const rows = this.db.prepare("SELECT post,notes FROM videos WHERE account=? AND state IN ('ready','needs_review','needs_confirmation')").all(account);
            const words = ` ${normalize(message)} `;
            candidates = rows.filter(v => JSON.parse(v.notes).keywords.some(k => words.includes(` ${normalize(k)} `))).map(v => v.post);
            if (candidates.length)
                reason = 'keyword';
            else if (/\b(?:another|different|other|new)\s+(?:house|home|property|video)\b/i.test(message))
                reason = 'switch';
            else {
                const context = this.db.prepare("SELECT post FROM video_context WHERE account=? AND person=? AND at>?").get(account, person, now - 7 * 86400000);
                if (context) {
                    candidates = [context.post];
                    reason = 'conversation';
                }
                else {
                    candidates = this.db.prepare("SELECT post FROM video_comments WHERE account=? AND person=? AND at>?").all(account, person, now - 7 * 86400000).map(x => x.post);
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
        const video = this.get(account, candidates[0]);
        // Unknown explicit references never fall back to a previously discussed home.
        this.db.prepare("INSERT INTO video_context VALUES(?,?,?,?) ON CONFLICT(account,person) DO UPDATE SET post=excluded.post,at=excluded.at").run(account, person, candidates[0], now);
        return video?.state === 'ready' ? { video, reason } : { reason: 'pending' };
    }
    close() { this.db.close(); }
}
exports.VideoStore = VideoStore;
