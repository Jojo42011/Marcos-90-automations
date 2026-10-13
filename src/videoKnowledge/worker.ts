import { extractSource, reconcileEvidence } from "./extraction.js";
import { VideoStore, validateNotes, type Video, type Notes } from "./store.js";
import { zernioRequest, transcribeVideo } from "./media.js";
export function parseExtractedNotes(text: string, video: Pick<Video, 'caption' | 'transcript'>): Notes {
    // Accept a single JSON code fence, but never salvage partial JSON or skip evidence validation.
    const trimmed = text.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
    return validateNotes(JSON.parse(fenced ? fenced[1]! : trimmed), video);
}
export async function extractNotes(video: Video, transcript: string): Promise<Notes> {
    const sources = {caption:video.caption,transcript};
    const caption = await extractSource(sources,'caption');
    const speech = await extractSource(sources,'transcript');
    return {...reconcileEvidence(caption.facts,speech.facts,sources),warnings:[...caption.warnings,...speech.warnings]};
}

export async function syncVideos(store: VideoStore, account: string, request = zernioRequest): Promise<number> {
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
export async function processVideo(store: VideoStore, account: string, deps = { transcribe: transcribeVideo, extract: extractNotes }): Promise<string> {
    const video = store.claim(account);
    if (!video)
        return 'idle';
    let stage: 'transcription' | 'fact_extraction' = 'transcription';
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
export function startVideoWorker(store: VideoStore, account: string): () => void {
    let stopped = false, timer: ReturnType<typeof setTimeout>, nextSync = 0;
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
