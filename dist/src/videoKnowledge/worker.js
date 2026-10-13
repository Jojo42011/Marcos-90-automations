"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseExtractedNotes = parseExtractedNotes;
exports.extractNotes = extractNotes;
exports.syncVideos = syncVideos;
exports.processVideo = processVideo;
exports.startVideoWorker = startVideoWorker;
const extraction_js_1 = require("./extraction.js");
const store_js_1 = require("./store.js");
const media_js_1 = require("./media.js");
function parseExtractedNotes(text, video) {
    // Accept a single JSON code fence, but never salvage partial JSON or skip evidence validation.
    const trimmed = text.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
    return (0, store_js_1.validateNotes)(JSON.parse(fenced ? fenced[1] : trimmed), video);
}
async function extractNotes(video, transcript) {
    const sources = { caption: video.caption, transcript };
    const caption = await (0, extraction_js_1.extractSource)(sources, 'caption');
    const speech = await (0, extraction_js_1.extractSource)(sources, 'transcript');
    return { ...(0, extraction_js_1.reconcileEvidence)(caption.facts, speech.facts, sources), warnings: [...caption.warnings, ...speech.warnings] };
}
async function syncVideos(store, account, request = media_js_1.zernioRequest) {
    const data = await request('/accounts/' + encodeURIComponent(account) + '/posts');
    if (!Array.isArray(data.posts))
        throw new Error('Unexpected Zernio post listing');
    let count = 0;
    for (const p of data.posts) {
        if (p.platform !== 'tiktok' || (p.mediaType && p.mediaType !== 'video'))
            continue;
        // Strict metadata validation: do not substitute discovery time for publication time.
        try {
            if (store.ingest({ account, post: p.id, url: p.permalink, caption: p.message || '', published: p.createdTime }))
                count++;
        }
        catch {
            console.error('[videoKnowledge] Skipped a post with incomplete video metadata');
        }
    }
    return count;
}
async function processVideo(store, account, deps = { transcribe: media_js_1.transcribeVideo, extract: extractNotes }) {
    const video = store.claim(account);
    if (!video)
        return 'idle';
    let stage = 'transcription';
    try {
        const transcript = video.transcript || await deps.transcribe(video);
        store.saveTranscript(video, transcript);
        stage = 'fact_extraction';
        const notes = await deps.extract(video, transcript);
        store.complete(video, transcript, notes);
        return store.get(account, video.post)?.state || 'needs_review';
    }
    catch {
        store.fail(video, stage);
        return 'failed';
    }
}
function startVideoWorker(store, account) {
    let stopped = false, timer, nextSync = 0;
    const tick = async () => {
        if (stopped)
            return;
        if (Date.now() >= nextSync) {
            nextSync = Date.now() + 10 * 60000;
            try {
                await syncVideos(store, account);
            }
            catch {
                console.error('[videoKnowledge] Post sync failed; check Zernio access. Next scheduled sync will retry.');
            }
        }
        await processVideo(store, account).catch(() => console.error('[videoKnowledge] Worker unavailable'));
        if (!stopped) {
            timer = setTimeout(tick, 5000);
            timer.unref();
        }
    };
    timer = setTimeout(tick, 1000);
    timer.unref();
    return () => { stopped = true; clearTimeout(timer); };
}
