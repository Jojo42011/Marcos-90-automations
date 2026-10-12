"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.videoRepliesEnabled = exports.videoEnabled = void 0;
exports.videoStore = videoStore;
exports.closeVideoStore = closeVideoStore;
exports.startVideoKnowledge = startVideoKnowledge;
exports.rememberVideoComment = rememberVideoComment;
exports.hasVideoKeyword = hasVideoKeyword;
exports.videoReply = videoReply;
exports.videoAdmin = videoAdmin;
const tenantData_js_1 = require("../core/tenantData.js");
const node_crypto_1 = require("node:crypto");
const store_js_1 = require("./store.js");
const worker_js_1 = require("./worker.js");
const media_js_1 = require("./media.js");
const videoEnabled = () => process.env.VIDEO_KNOWLEDGE_ENABLED === 'true';
exports.videoEnabled = videoEnabled;
const videoRepliesEnabled = () => (0, exports.videoEnabled)() && process.env.VIDEO_KNOWLEDGE_REPLIES_ENABLED === 'true';
exports.videoRepliesEnabled = videoRepliesEnabled;
const account = () => process.env.ZERNIO_TIKTOK_ACCOUNT_ID?.trim() || '';
let instance;
function databasePath() { return process.env.VIDEO_KNOWLEDGE_DB_PATH || (0, tenantData_js_1.dataPath)('video-knowledge.db'); }
function videoStore() {
    if (!instance)
        instance = new store_js_1.VideoStore(databasePath());
    return instance;
}
function closeVideoStore() { instance?.close(); instance = undefined; }
function startVideoKnowledge() {
    if (!(0, exports.videoEnabled)() || !account())
        return () => { };
    return (0, worker_js_1.startVideoWorker)(videoStore(), account());
}
/** Called only after the existing webhook signature/account checks. */
function rememberVideoComment(event) {
    if (!(0, exports.videoEnabled)() || !account() || event.accountId !== account() || event.platform !== 'tiktok' || event.isReply)
        return;
    try {
        videoStore().comment(account(), event.authorId, event.platformPostId, Date.parse(event.createdAt || ''));
    }
    catch {
        console.error('[videoKnowledge] Comment context unavailable');
    }
}
/** Ready keywords can help the existing intent gate, after its safety exclusions. */
function hasVideoKeyword(message) {
    if (!(0, exports.videoRepliesEnabled)() || !account())
        return false;
    try {
        const words = ` ${message.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
        const videos = videoStore().db.prepare("SELECT notes FROM videos WHERE account=? AND state='ready'").all(account());
        return videos.some(v => JSON.parse(v.notes).keywords.some(k => words.includes(` ${k} `)));
    }
    catch {
        return false;
    }
}
const queries = { city: /\b(?:city|where|location|is it in)\b/i, area: /\b(?:area|neighbou?rhood)\b/i, address: /\baddress\b/i, price: /\b(?:price|pricing|cost|how much)\b/i, bedrooms: /\b(?:bedrooms?|beds?)\b/i, bathrooms: /\b(?:bathrooms?|baths?)\b/i, size: /\b(?:size|square feet|sq\.?\s?ft)\b/i, acreage: /\b(?:acreage|acres?|lot)\b/i, builder: /\bbuilder\b/i, features: /\b(?:features?|pool|garage|elevator|barn)\b/i };
function videoReply(person, message, store, accountId = account(), enabled = (0, exports.videoRepliesEnabled)()) {
    if (!enabled || !accountId)
        return null;
    try {
        const result = (store || videoStore()).resolve(accountId, person, message);
        const fields = Object.keys(queries).filter(f => queries[f].test(message));
        const general = /\b(?:info|information|details|tell me|available|availability)\b/i.test(message);
        const propertyQuestion = /\b(?:does (?:it|this house|that house) (?:have|include)|how (?:many|big|old)|is it in)\b/i.test(message);
        if (!fields.length && !general && !propertyQuestion && !['link', 'keyword', 'ambiguous', 'unknown'].includes(result.reason))
            return null;
        // A broad buyer question is not necessarily about the previously selected property.
        if (/\b(?:my budget|i (?:live|work)|do you (?:work|sell|cover)|buying process|closing costs|interest rate)\b/i.test(message))
            return null;
        if (result.reason === 'ambiguous')
            return 'More than one video matches that. Which house do you mean—what was its specific keyword or location?';
        if (!result.video) {
            if (result.reason === 'none')
                return null; // Existing missing-info guard handles this.
            return "I don't have confirmed details for that specific video yet. What was the house's keyword or location?";
        }
        if (/\b(?:available|availability|sold|pending|current price|price now)\b/i.test(message))
            return "The video doesn't confirm today's price or availability. I'll need to verify that for you.";
        const notes = JSON.parse(result.video.notes);
        if (propertyQuestion && !fields.length)
            return "I found the video, but it doesn't have confirmed information for that question. I'll need to verify that detail.";
        const selected = fields.length ? notes.facts.filter(f => fields.includes(f.field)) : notes.facts.filter(f => ['city', 'bedrooms', 'bathrooms'].includes(f.field));
        if (!selected.length)
            return "I found the video, but it doesn't have confirmed information for that question. I'll need to verify that detail.";
        const labels = { city: 'location', area: 'area', address: 'address', price: 'advertised price', bedrooms: 'bedrooms', bathrooms: 'bathrooms', size: 'size', acreage: 'acreage', builder: 'builder', features: 'features' };
        const missing = fields.some(f => !selected.some(s => s.field === f));
        const shown = selected.slice(0, 3);
        const render = () => `The video posted ${result.video.published.slice(0, 10)} lists ${shown.map(f => `${labels[f.field]}: ${f.value}`).join('; ')}.` + (shown.some(f => f.field === 'price') ? " I'll need to confirm the current price." : '') + (missing ? " I'll need to verify the other details." : shown.length < selected.length ? " I can share the other details next." : '');
        while (render().length > 320 && shown.length > 1)
            shown.pop();
        return render();
    }
    catch {
        console.error('[videoKnowledge] Lookup unavailable; using existing DM behavior');
        return null;
    }
}
/** Auth is enforced by each server before this handler. Account cannot be supplied by the caller. */
async function videoAdmin(method, body = {}, offset = 0) {
    if (method === 'GET')
        return { enabled: (0, exports.videoEnabled)(), repliesEnabled: (0, exports.videoRepliesEnabled)(), accountConfigured: Boolean(account()), mediaModelConfigured: Boolean(process.env.VIDEO_WHISPER_MODEL), factExtractionConfigured: Boolean(process.env.ANTHROPIC_API_KEY), items: account() ? videoStore().list(account(), Math.floor(offset)) : [] };
    if (!account())
        throw new Error('TikTok account is not configured');
    if (!(0, exports.videoEnabled)())
        throw new Error('Video knowledge is disabled');
    if (body?.action === 'preview') {
        if (typeof body.message !== 'string' || body.message.length > 2000)
            throw new Error('Provide a short test message');
        const person = 'preview:' + (0, node_crypto_1.randomUUID)();
        try {
            return { reply: videoReply(person, body.message, videoStore(), account(), true), sent: false };
        }
        finally {
            videoStore().db.prepare('DELETE FROM video_context WHERE account=? AND person=?').run(account(), person);
        }
    }
    if (body?.action === 'sync')
        return { imported: await (0, worker_js_1.syncVideos)(videoStore(), account()) };
    if (body?.action === 'import') {
        if (typeof body.url !== 'string' || body.url.length > 1000)
            throw new Error('Provide a TikTok video URL');
        const data = await (0, media_js_1.zernioRequest)('/posts/sync-external', { accountId: account(), url: body.url });
        const p = data.post;
        if (!data.found || p?.platform !== 'tiktok')
            throw new Error('Post was not found on the connected account');
        videoStore().ingest({ account: account(), post: p.platformPostId, url: p.platformPostUrl, caption: p.content || '', published: p.publishedAt });
        return videoStore().get(account(), p.platformPostId);
    }
    if (!['approve', 'disable', 'retry'].includes(body?.action) || typeof body.post !== 'string' || typeof body.revision !== 'string')
        throw new Error('Invalid video review request');
    return videoStore().review(account(), body.post, body.revision, body.action, body.notes);
}
