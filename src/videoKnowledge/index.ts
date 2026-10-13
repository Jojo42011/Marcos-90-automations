import { dataPath } from "../core/tenantData.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { VideoStore, type Notes, type Field } from "./store.js";
import { startVideoWorker, syncVideos } from "./worker.js";
import { inspectVideo } from "./downloader.js";
import { zernioRequest } from "./media.js";
export const videoEnabled = () => process.env.VIDEO_KNOWLEDGE_ENABLED === 'true';
export const videoRepliesEnabled = () => videoEnabled() && process.env.VIDEO_KNOWLEDGE_REPLIES_ENABLED === 'true';
const account = () => process.env.ZERNIO_TIKTOK_ACCOUNT_ID?.trim() || '';
let instance: VideoStore | undefined;
function databasePath(): string { return process.env.VIDEO_KNOWLEDGE_DB_PATH || dataPath('video-knowledge.db'); }
export function videoStore(): VideoStore { if (!instance)
    instance = new VideoStore(databasePath()); return instance; }
export function closeVideoStore(): void { instance?.close(); instance = undefined; }
export function startVideoKnowledge(): () => void {
    if (!videoEnabled() || !account())
        return () => { };
    return startVideoWorker(videoStore(), account());
}
/** Called only after the existing webhook signature/account checks. */
export function rememberVideoComment(event: {
    accountId?: string | null;
    platform: string;
    authorId: string;
    platformPostId: string;
    createdAt: string | null;
    isReply: boolean;
}): void {
    if (!videoEnabled() || !account() || event.accountId !== account() || event.platform !== 'tiktok' || event.isReply)
        return;
    try {
        videoStore().comment(account(), event.authorId, event.platformPostId, Date.parse(event.createdAt || ''));
    }
    catch {
        console.error('[videoKnowledge] Comment context unavailable');
    }
}
/** Ready keywords can help the existing intent gate, after its safety exclusions. */
export function hasVideoKeyword(message: string): boolean {
    if (!videoRepliesEnabled() || !account())
        return false;
    try {
        const words = ` ${message.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
        const videos = videoStore().db.prepare("SELECT notes FROM videos WHERE account=? AND state IN ('ready','needs_review','needs_confirmation')").all(account()) as {
            notes: string;
        }[];
        return videos.some(v => (JSON.parse(v.notes) as Notes).keywords.some(k => words.includes(` ${k} `)));
    }
    catch {
        return false;
    }
}
const queries: Record<Field, RegExp> = { city: /\b(?:city|where|location|is it in)\b/i, area: /\b(?:area|neighbou?rhood|where|location)\b/i, address: /\baddress\b/i, price: /\b(?:price|pricing|cost|how much)\b/i, bedrooms: /\b(?:bedrooms?|beds?)\b/i, bathrooms: /\b(?:bathrooms?|baths?)\b/i, size: /\b(?:size|square feet|sq\.?\s?ft)\b/i, acreage: /\b(?:acreage|acres?|lot)\b/i, builder: /\bbuilder\b/i, features: /\b(?:features?|pool|garage|elevator|barn)\b/i };
export function videoReply(person: string, message: string, store?: VideoStore, accountId = account(), enabled = videoRepliesEnabled()): string | null {
    if (!enabled || !accountId)
        return null;
    try {
        const result = (store || videoStore()).resolve(accountId, person, message);
        const notes = result.video ? JSON.parse(result.video.notes) as Notes : undefined;
        // A leading CTA identifies the video; it isn't itself a requested feature.
        let question = message;
        for (const keyword of notes?.keywords || []) {
            const normalized = question.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
            if (normalized === keyword) question = '';
            else if (normalized.startsWith(keyword + ' ')) {
                const tokens = keyword.split(' ').length;
                const words = [...question.matchAll(/[\p{L}\p{N}]+/gu)];
                question = question.slice((words[tokens-1]?.index || 0) + (words[tokens-1]?.[0].length || 0));
            }
        }
        const fields = (Object.keys(queries) as Field[]).filter(f => queries[f].test(question));
        const general = /\b(?:info|information|details|tell me|available|availability)\b/i.test(message);
        const propertyQuestion = /\b(?:does (?:it|this house|that house) (?:have|include)|how (?:many|big|old)|is it in)\b/i.test(message);
        if (!fields.length && !general && !propertyQuestion && !['link', 'keyword', 'ambiguous', 'unknown'].includes(result.reason))
            return null;
        // A broad buyer question is not necessarily about the previously selected property.
        if (/\b(?:my budget|i (?:live|work)|do you (?:work|sell|cover)|buying process|closing costs|interest rate)\b/i.test(message))
            return null;
        if (result.reason === 'ambiguous')
            return 'More than one video matches that. Which house do you mean—what was its specific keyword or location?';
        if (result.reason === 'pending') return "I found that video, but its details are still being checked. I'll need to confirm them before sharing specifics.";
        if (!result.video) {
            if (result.reason === 'none')
                return null; // Existing missing-info guard handles this.
            return "I don't have confirmed details for that specific video yet. What was the house's keyword or location?";
        }
        if (/\b(?:available|availability|sold|pending|current price|price now)\b/i.test(message))
            return "The video doesn't confirm today's price or availability. I'll need to verify that for you.";
        if (!notes) return null;
        if (propertyQuestion && !fields.length)
            return "I found the video, but it doesn't have confirmed information for that question. I'll need to verify that detail.";
        const requestedFeature = question.match(/\b(pool|garage|elevator|barn)\b/i)?.[1];
        const selected = fields.length ? notes.facts.filter(f => fields.includes(f.field) && (f.field !== 'features' || !requestedFeature || f.value.toLowerCase().includes(requestedFeature.toLowerCase()))) : notes.facts.filter(f => ['city', 'bedrooms', 'bathrooms'].includes(f.field));
        if (!selected.length)
            return "I found the video, but it doesn't have confirmed information for that question. I'll need to verify that detail.";
        const labels: Record<Field, string> = { city: 'location', area: 'area', address: 'address', price: 'advertised price', bedrooms: 'bedrooms', bathrooms: 'bathrooms', size: 'size', acreage: 'acreage', builder: 'builder', features: 'features' };
        const missing = fields.some(f => !selected.some(s => s.field === f || (['city','area'].includes(f) && fields.includes('city') && fields.includes('area') && ['city','area'].includes(s.field))));
        const shown = selected.slice(0, 3);
        const render = () => `The video posted ${result.video!.published.slice(0, 10)} lists ${shown.map(f => `${labels[f.field]}: ${f.value}`).join('; ')}.` + (shown.some(f => f.field === 'price') ? " I'll need to confirm the current price." : '') + (missing ? " I'll need to verify the other details." : shown.length < selected.length ? " I can share the other details next." : '');
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
export async function videoAdmin(method: string, body: any = {}, offset = 0): Promise<unknown> {
    if (method === 'GET')
        return { summary: account() ? videoStore().summary(account()) : {}, enabled: videoEnabled(), repliesEnabled: videoRepliesEnabled(), accountConfigured: Boolean(account()), mediaModelConfigured: Boolean(process.env.VIDEO_WHISPER_MODEL), factExtractionConfigured: Boolean(process.env.ANTHROPIC_API_KEY), items: account() ? videoStore().list(account(), Math.floor(offset)) : [] };
    if (!account())
        throw new Error('TikTok account is not configured');
    if (!videoEnabled())
        throw new Error('Video knowledge is disabled');
    if (body?.action === 'preview') {
        if (typeof body.message !== 'string' || body.message.length > 2000)
            throw new Error('Provide a short test message');
        const person = 'preview:' + randomUUID();
        try {
            return { reply: videoReply(person, body.message, videoStore(), account(), true), sent: false };
        }
        finally {
            videoStore().db.prepare('DELETE FROM video_context WHERE account=? AND person=?').run(account(), person);
        }
    }
    if (body?.action === 'sync')
        return { imported: await syncVideos(videoStore(), account()) };
    if (body?.action === 'import') {
        if (typeof body.url !== 'string' || body.url.length > 1000)
            throw new Error('Provide a TikTok video URL');
        return importOwnedVideo(videoStore(),account(),body.url);

    }
    if (!['approve', 'disable', 'retry'].includes(body?.action) || typeof body.post !== 'string' || typeof body.revision !== 'string')
        throw new Error('Invalid video review request');
    return videoStore().review(account(), body.post, body.revision, body.action, body.notes, body.resolutions, body.acknowledgeWarnings === true);
}

/** Historical imports verify the canonical video's author against the connected account. */
export async function importOwnedVideo(store: VideoStore, accountId: string, url: string, request = zernioRequest, inspect = inspectVideo): Promise<unknown> {
    const data=await request('/accounts');
    const accounts=Array.isArray(data.accounts)?data.accounts:Array.isArray(data.data)?data.data:[];
    const connected=accounts.find((a: any)=>String(a._id??a.id??a.accountId)===accountId&&a.platform==='tiktok');
    const username=String(connected?.username||'').replace(/^@/,'').toLowerCase();
    if(!username)throw Error('Connected TikTok username is unavailable; refresh account access before importing');
    const meta=await inspect(url);
    const author=new URL(meta.webpage_url).pathname.match(/^\/@([^/]+)\/video\/\d+/)?.[1]?.toLowerCase();
    if(author!==username)throw Error('Video is not from this connected TikTok account');
    const timestamp=Number(meta.timestamp);
    if(!Number.isFinite(timestamp)||timestamp<=0)throw Error('Video publication date is unavailable');
    store.ingest({account:accountId,post:String(meta.id),url:meta.webpage_url,caption:String(meta.description||''),published:new Date(timestamp*1000).toISOString()});
    return store.get(accountId,String(meta.id));
}
